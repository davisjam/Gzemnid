'use strict';

const path = require('path');
const util = require('util');
const child_process = require('child_process');
const fs = require('../fs');
const config = require('../config').config;
const readline = require('readline');
const babylon = require('babylon');
const { readlines, promiseEvent, packedOut, packedIn } = require('../helpers');

const execFile = util.promisify(child_process.execFile);

const extensions = [
  //'.php', '.json', '.txt',
  '.ts', '.coffee', '.js'
];

let excludedLoaded;
async function loadExcluded() {
  if (excludedLoaded) return excludedLoaded;
  const lines = await readlines(path.join(config.basedir, 'data/code.excluded.txt'));
  excludedLoaded = lines
    .filter(x => !!x)
    .map(x => {
      let fixFront = false;
      let fixTail = false;
      if (x[0] === '*') {
        x = x.slice(1);
      } else if (x[0] !== '/') {
        fixFront = true;
      }
      if (x[x.length - 1] === '*') {
        x = x.substr(0, x.length - 1);
      } else if (x[x.length - 1] !== '/') {
        fixTail = true;
      }
      x = x.replace(/[^\w\s]/g, '\\$&');
      if (fixFront) {
        x = `(/|^)${x}`;
      }
      if (fixTail) {
        x = `${x}(/|$)`;
      }
      x = x.replace(/\\\*/g, '.*')
           .replace(/\\\?/g, '.');
      return new RegExp(x);
    });
  return excludedLoaded;
}

async function listTar(file) {
  const tar = await execFile(
    'tar',
    ['--list', '--warning=no-unknown-keyword', '-f', file],
    { maxBuffer: 50 * 1024 * 1024 }
  );
  return tar.stdout
            .split('\n')
            .filter(x => !!x)
            .filter(x => x !== 'package')
            .sort();
}

async function slimCode(ext, outdir, tgz, slim) {
  const outfile = path.join(outdir, `slim.code${ext}.txt`);
  const out = fs.createWriteStream(outfile);
  const entries = slim.filter(entry => entry.endsWith(ext));
  for (const entry of entries) {
    const stream = fs.createReadStream(path.join(config.dir, 'tmp', entry));
    const resume = () => stream.resume();
    out.on('drain', resume);
    let num = 0;
    readline.createInterface({
      input: stream
    }).on('line', line => {
      num++;
      if (line.length > 500) return;
      if (!/[^\s]/.test(line)) return;
      const ready = out.write(`${entry}:${num}:${line}\n`);
      if (!ready) stream.pause();
    });
    await promiseEvent(stream);
    out.removeListener('drain', resume);
  }
  out.end();
  await promiseEvent(out, 'close');
}

function getAST(code, ext) {
  const density = code.length / code.split('\n').length;
  if (density > 200) {
    // This is probably a minified file
    return 'minified';
  }
  switch (ext) {
    case '.js':
      try {
        return babylon.parse(code);
      } catch (e) { /* ignore */ }
      try {
        return babylon.parse(code, { sourceType: 'module' });
      } catch (e) { /* ignore */ }
      break;
  }
  return 'unparsed';
}

async function slimAST(ext, outdir, tgz, slim) {
  //console.log(`Building AST for ${tgz}...`);
  const outfile = path.join(outdir, `slim.ast${ext}.json`);
  const out = packedOut(outfile, config.extract.compress);
  const entries = slim.filter(entry => entry.endsWith(ext));
  out.write('{');
  let count = 0;
  for (const entry of entries) {
    const filepath = path.join(config.dir, 'tmp', entry);
    const code = await fs.readFile(filepath, 'utf-8');
    const ast = getAST(code, ext);
    if (count !== 0) {
      out.write(',');
    }
    const ready = out.write(`\n ${JSON.stringify(entry)}: ${JSON.stringify(ast)}`);
    if (!ready) await promiseEvent(out, 'drain');
    count++;
  }
  out.write('\n}\n');
  out.end();
  await promiseEvent(out, 'close');
}

async function partial(tgz, rebuild) {
  const file = path.join(config.dir, 'current/', tgz);
  const outdir = path.join(config.dir, 'partials/', tgz);

  let files;

  if (rebuild) {
    try {
      files = await readlines(path.join(outdir, 'files.txt'));
    } catch (e) {
      // Just fall back to reading the tar
    }
  }

  await fs.mkdirp(outdir);

  if (!files) {
    const lines = await listTar(file);
    if (!lines.every(x => x.indexOf('/') !== -1)) {
      throw new Error('Package contains top-level files!');
    }
    files = lines.map(x => x.replace(/[^/]*\//, ''))
                 .map(x => `${tgz}/${x}`);
    await fs.writeFile(path.join(outdir, 'files.txt'), files.join('\n'));
    // TODO: rebuild new extensions on extensions list changes
    for (const ext of extensions) {
      await fs.writeFile(
        path.join(outdir, `files${ext}.txt`),
        files.filter(entry => entry.endsWith(ext)).join('\n')
      );
    }
  }

  const excluded = await loadExcluded();
  const slim = files.filter(entry => !excluded.some(rexp => rexp.test(entry)));
  await fs.writeFile(path.join(outdir, 'slim.files.txt'), slim.join('\n'));
  for (const ext of extensions) {
    await fs.writeFile(
      path.join(outdir, `slim.files${ext}.txt`),
      slim.filter(entry => entry.endsWith(ext)).join('\n')
    );
  }

  const tmp = path.join(config.dir, 'tmp/', tgz);
  await fs.mkdirp(tmp);
  const args = [
    '--strip-components=1',
    '--warning=no-unknown-keyword',
    '-xf',
    path.join('..', '..', 'current', tgz),
    '--wildcards'
  ];
  args.push('*/package.json');
  for (const ext of extensions) {
    if (slim.some(entry => entry.endsWith(ext))) {
      args.push(`*${ext}`);
    }
  }
  await execFile('tar', args, {
    cwd: tmp,
    stdio: 'ignore',
    maxBuffer: 50 * 1024 * 1024
  });

  // TODO: only if not exists
  await fs.copy(
    path.join(tmp, 'package.json'),
    path.join(outdir, 'package.json')
  );

  for (const ext of extensions) {
    await slimCode(ext, outdir, tgz, slim);
  }

  if (config.extract.features.ast) {
    await slimAST('.js', outdir, tgz, slim);
  }

  await fs.rmrf(tmp);
}

async function partials(subcommand, single) {
  if (subcommand && subcommand !== 'rebuild') {
    throw new Error(`Partials: unexpected command: ${subcommand}`);
  }
  const rebuild = subcommand === 'rebuild';
  await fs.mkdirp(path.join(config.dir, 'partials/'));
  console.log('Reading packages directory...');
  const current = await fs.readdir(path.join(config.dir, 'current/'));
  console.log('Reading partials directory...');
  const present = await fs.readdir(path.join(config.dir, 'partials/'));
  const currentSet = new Set(current);
  const presentSet = new Set(present);
  let removed = 0;
  for (const tgz of present) {
    if (single && tgz !== single) continue;
    if (currentSet.has(tgz)) continue;
    const dir = path.join(config.dir, 'partials', tgz);
    await fs.rmrf(dir);
    removed++;
    if (removed % 10000 === 0) {
      console.log(`Partials: removing ${removed}...`);
    }
  }
  console.log(`Partials: removed ${removed}.`);
  const tmp = path.join(config.dir, 'tmp/');
  await fs.rmrf(tmp);
  await fs.mkdirp(tmp);
  let built = 0;
  let errors = 0;
  const total = currentSet.size - presentSet.size + removed;
  for (const tgz of current) {
    if (single && tgz !== single) continue;
    if (!rebuild && presentSet.has(tgz)) continue;
    console.log(`Partial: building ${tgz}`);
    try {
      await partial(tgz, rebuild);
    } catch (e) {
      console.error(`Partial: failed ${tgz}: ${e}`);
      errors++;
      await fs.rmrf(path.join(config.dir, 'partials/', tgz));
      await fs.rmrf(path.join(config.dir, 'tmp/', tgz));
      continue;
    }
    built++;
    if (built % 10000 === 0) {
      console.log(`Partials: building ${built} / ${total - errors}...`);
    }
  }
  console.log(`Partials: built ${built}, errors: ${errors}.`);
  await fs.rmrf(tmp);
}

async function totalsAST(available) {
  console.log('Totals: building AST...');
  const outdir = path.join(config.dir, 'out/');
  const filenames = [];
  for (const ext of ['.js']) {
    filenames.push(`slim.ast${ext}.json`);
  }
  const streams = {};
  for (const file of filenames) {
    streams[file] = packedOut(path.join(outdir, file), config.extract.compress);
    streams[file].write('{');
  }
  let built = 0;
  for (const tgz of available) {
    const tgzdir = path.join(config.dir, 'partials/', tgz);
    for (const file of filenames) {
      const stream = packedIn(path.join(tgzdir, file), config.extract.compress);
      readline.createInterface({
        input: stream
      }).on('line', line => {
        if (line === '{' || line === '}') return;
        streams[file].write(streams[file].length === 1 ? '\n' : ',\n');
        streams[file].write(line.endsWith(',') ? line.slice(0, -1) : line);
      });
      await promiseEvent(stream);
    }
    built++;
    if (built % 10000 === 0) {
      console.log(`Totals: AST ${built} / ${available.length}...`);
    }
  }
  const promises = [];
  for (const file of filenames) {
    streams[file].write('\n}\n');
    streams[file].end();
    promises.push(promiseEvent(streams[file]));
  }
  await Promise.all(promises);
}

async function totals() {
  console.log('Totals: cleaning up...');
  const outdir = path.join(config.dir, 'out/');
  await fs.rmrf(outdir);
  await fs.mkdirp(outdir);

  console.log('Totals: building packages list...');
  const current = await fs.readdir(path.join(config.dir, 'current/'));
  current.sort();
  const out = fs.createWriteStream(path.join(outdir, 'packages.txt'));
  for (const tgz of current) {
    out.write(`${tgz}\n`);
  }
  out.end();
  await promiseEvent(out, 'close');
  console.log(`Totals: packages.txt complete, ${current.length} packages.`);

  console.log('Totals: processing partials...');
  const available = await fs.readdir(path.join(config.dir, 'partials/'));
  available.sort();
  console.log(`Totals: found ${available.length} partials.`);

  const filenames = ['files.txt', 'slim.files.txt'];
  for (const ext of extensions) {
    filenames.push(`files${ext}.txt`);
    filenames.push(`slim.files${ext}.txt`);
    filenames.push(`slim.code${ext}.txt`);
  }
  const streams = {};
  for (const file of filenames) {
    streams[file] = packedOut(path.join(outdir, file), config.extract.compress);
  }
  let built = 0;
  for (const tgz of available) {
    const tgzdir = path.join(config.dir, 'partials/', tgz);
    for (const file of filenames) {
      const filepath = path.join(tgzdir, file);
      const stream = fs.createReadStream(filepath);
      stream.on('data', line => {
        streams[file].write(line);
      });
      await promiseEvent(stream);
    }
    built++;
    if (built % 10000 === 0) {
      console.log(`Totals: building ${built} / ${available.length}...`);
    }
  }
  const promises = [];
  for (const file of filenames) {
    if (config.extract.compress && streams[file].length === 0) {
      // lz4 fails on empty files for some reason
      streams[file].write('\n');
    }
    streams[file].end();
    promises.push(promiseEvent(streams[file]));
  }
  await Promise.all(promises);
  console.log(`Totals: processed ${built} partials.`);

  if (config.extract.features.ast) {
    await totalsAST(available);
  }

  console.log('Totals: done!');
}

async function run() {
  await partials();
  await totals();
}

module.exports = {
  run,
  partials,
  totals
};

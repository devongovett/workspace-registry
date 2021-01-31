#!/usr/bin/env node

import {createServer} from 'http';
import {execSync} from 'child_process';
import path from 'path';
import fs, { readdir } from 'fs';
import {createHash} from 'crypto';
import tar from 'tar-stream';
import httpProxy from 'http-proxy';
import {createGzip} from 'zlib';

let proxy = httpProxy.createProxyServer({});

let server = createServer(async (req, res) => {
  let m;
  if ((m = req.url.match(/^\/((:?@[^/]+\/)?[^/]+)$/))) {
    try {
      let name = decodeURIComponent(m[1]);
      let info = await getPackageInfo(name);
      let data = JSON.stringify(info);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', data.length);
      res.writeHead(200);
      res.end(data);
    } catch (err) {
      proxy.web(req, res, {target: 'https://registry.npmjs.com/', changeOrigin: true});
    }
  } else if ((m = req.url.match(/^\/((:?@[^/]+\/)?[^/]+)\/-\/.*?\.tgz$/))) {
    try {
      let name = decodeURIComponent(m[1]);
      let stream = getPackageTarball(name);
      res.setHeader('Content-Type', 'application/tar+gzip');
      res.writeHead(200);
      stream.pipe(res);
    } catch (err) {
      proxy.web(req, res, {target: 'https://registry.npmjs.com/', changeOrigin: true});
    }
  } else {
    res.writeHead(400);
    res.end('Bad request');
  }
});

function createCachedFunction(fn) {
  let cache = new Map();
  return (arg) => {
    let cached = cache.get(arg);
    if (!cached || (Date.now() - cached.ts) > 10000) {
      let res = fn(arg);
      cache.set(arg, {res, ts: Date.now()});
      return res;
    }

    return cached.res;
  }
}

const getPackages = createCachedFunction(() => {
  return JSON.parse(execSync('yarn workspaces info --json').toString().split('\n').slice(1, -2).join('\n'));
});

const getPackageInfo = createCachedFunction(async packageName => {
  let packages = getPackages();
  let pkg = packages[packageName];
  if (!pkg) {
    throw new Error(`Unknown package ${packageName}`);
  }

  let pkgJSON = JSON.parse(fs.readFileSync(path.join(pkg.location, 'package.json'), 'utf8'));
  processDependencies(pkgJSON.dependencies, packages);
  processDependencies(pkgJSON.devDependencies, packages);
  processDependencies(pkgJSON.optionalDependencies, packages);
  processDependencies(pkgJSON.peerDependencies, packages);

  let stat = fs.statSync(pkg.location);

  let hash = getPackageHash(pkg.location);
  let version = pkgJSON.version + '-' + hash;

  let tarball = getPackageTarball(packageName);
  let shasum = await new Promise((resolve, reject) => {
    tarball.on('error', reject);
    tarball.pipe(createHash('sha1').setEncoding('hex'))
      .on('finish', function () { resolve(this.read()) })
      .on('error', reject);
  });

  return {
    _id: pkgJSON.name,
    _rev: hash,
    name: pkgJSON.name,
    description: pkgJSON.description,
    'dist-tags': {
      latest: version
    },
    versions: {
      [version]: {
        ...pkgJSON,
        version,
        dist: {
          shasum,
          tarball: `http://localhost:4321/${packageName}/-/${packageName}-${version}.tgz`
        }
      }
    },
    time: {
      modified: stat.mtime,
      created: stat.ctime,
      [version]: stat.mtime
    }
  };
});

function processDependencies(deps, packages) {
  if (!deps) {
    return;
  }

  for (let dep in deps) {
    let pkg = packages[dep];
    if (!pkg) {
      continue;
    }

    let hash = getPackageHash(pkg.location);
    let pkgJSON = JSON.parse(fs.readFileSync(path.join(pkg.location, 'package.json'), 'utf8'));
    let version = pkgJSON.version + '-' + hash;
    deps[dep] = version;
  }
}

const getPackageHash = createCachedFunction(packagePath => {
  let hash = createHash('md5');
  for (let filePath of readdirRecursive(packagePath)) {
    hash.update(fs.readFileSync(filePath));
  }

  return hash.digest('hex');
});

function getPackageTarball(packageName) {
  let packages = getPackages();
  let pkg = packages[packageName];
  if (!pkg) {
    throw new Error(`Unknown package ${packageName}`);
  }

  let pack = tar.pack();

  let addEntries = async () => {
    for (let filePath of readdirRecursive(pkg.location)) {
      await new Promise(async resolve => {
        let stat = fs.statSync(filePath);
        let header = {
          name: path.join('package', path.relative(pkg.location, filePath)),
          mode: stat.mode,
          mtime: stat.mtime,
          size: stat.size,
          type: stat.isDirectory() ? 'directory' : 'file',
          uid: stat.uid,
          gid: stat.gid
        };

        if (path.basename(filePath) === 'package.json') {
          let pkgJSON = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
          let hash = getPackageHash(path.dirname(filePath));
          pkgJSON.version += '-' + hash;
          processDependencies(pkgJSON.dependencies, packages);
          processDependencies(pkgJSON.devDependencies, packages);
          processDependencies(pkgJSON.optionalDependencies, packages);
          processDependencies(pkgJSON.peerDependencies, packages);
          pack.entry(header, JSON.stringify(pkgJSON, false, 2));
          resolve();
        } else {
          let entry = pack.entry(header, resolve);
          fs.createReadStream(filePath).pipe(entry);
        }
      });
    }

    pack.finalize();
  };

  addEntries();
  return pack.pipe(createGzip());
}

function *readdirRecursive(dirPath) {
  let entries = fs.readdirSync(dirPath);
  for (let entry of entries) {
    if (entry === 'node_modules') {
      continue;
    }

    let filePath = path.join(dirPath, entry);

    if (fs.statSync(filePath).isDirectory()) {
      yield* readdirRecursive(filePath);
    } else {
      yield filePath;
    }
  }
}

server.listen(4321);
console.log('Server listening on http://localhost:4321');

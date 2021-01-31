# workspace-registry

A virtual NPM registry server for testing packages locally without needing to manually publish.

It uses [Yarn workspaces](https://classic.yarnpkg.com/en/docs/workspaces/) as the source of truth,
and implements the [NPM registry API](https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md)
to respond to metadata and tarball requests on the fly.

The version of each package is based on a hash of all of the files in the package. This means that whenever
you change any file in a package, the version changes automatically. Note that this means that only a single 
version of the package is available at a time. No historical versions are retained.

Any dependency that is not in the Yarn workspaces monorepo is
proxied from the public NPM registry.

## Usage

1. Run the `workspace-registry` command within the root directory of your Yarn workspaces monorepo. 
   This starts a local registry server on port 4321.
2. In the project where you want to install packages from your monorepo, run 
   `yarn add PACKAGE_NAME --registry http://localhost:4321`.
3. When you want to update the packages from the monorepo, just `rm -rf node_modules yarn.lock` and run `yarn` again.

## License

MIT

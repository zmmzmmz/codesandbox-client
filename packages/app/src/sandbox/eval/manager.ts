import { flattenDeep, uniq, values } from 'lodash-es';
import { Protocol } from 'codesandbox-api';
import resolve from 'browser-resolve';

import * as pathUtils from '@codesandbox/common/lib/utils/path';
import _debug from '@codesandbox/common/lib/utils/debug';
import { getGlobal } from '@codesandbox/common/lib/utils/global';
import { ParsedConfigurationFiles } from '@codesandbox/common/lib/templates/template';
import DependencyNotFoundError from 'sandbox-hooks/errors/dependency-not-found-error';
import ModuleNotFoundError from 'sandbox-hooks/errors/module-not-found-error';

import { Module } from './entities/module';
import TranspiledModule, {
  ChildModule,
  SerializedTranspiledModule,
} from './transpiled-module';
import Preset from './presets';
import { SCRIPT_VERSION } from '..';
import fetchModule, {
  setCombinedMetas,
  combinedMetas,
} from './npm/fetch-npm-module';
import coreLibraries from './npm/get-core-libraries';
import getDependencyName from './utils/get-dependency-name';
import TestRunner from './tests/jest-lite';
import dependenciesToQuery from '../npm/dependencies-to-query';
import { packageFilter } from './utils/resolve-utils';

import { ignoreNextCache, deleteAPICache, clearIndexedDBCache } from './cache';
import { shouldTranspile } from './transpilers/babel/check';
import { splitQueryFromPath } from './utils/query-path';

declare const BrowserFS: any;

type Externals = {
  [name: string]: string;
};

export type ModuleObject = {
  [path: string]: Module;
};

export type Manifest = {
  contents: {
    [path: string]: { content: string; requires: Array<string> };
  };
  dependencies: Array<{ name: string; version: string }>;
  dependencyDependencies: {
    [name: string]: {
      semver: string;
      resolved: string;
      parents: string[];
    };
  };
  dependencyAliases: {
    [name: string]: {
      [depName: string]: string;
    };
  };
};

interface IFileResolver {
  protocol: Protocol;
  isFile: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
}

const NODE_LIBS = ['dgram', 'net', 'tls', 'fs', 'module', 'child_process'];
// For these dependencies we don't want to follow along with the `browser` field
const SKIPPED_BROWSER_FIELD_DEPENDENCIES = ['babel-core', '@babel/core'].reduce(
  (result, next) => ({
    ...result,
    [`/node_modules/${next}/package.json`]: true,
  }),
  {}
);
const SHIMMED_MODULE: Module = {
  path: pathUtils.join('/node_modules', 'empty', 'index.js'),
  code: `// empty`,
  requires: [],
};

const getShimmedModuleFromPath = (currentPath: string, path: string) => ({
  ...SHIMMED_MODULE,
  path: pathUtils.join(pathUtils.dirname(currentPath), path),
});
const debug = _debug('cs:compiler:manager');

export type HMRStatus = 'idle' | 'check' | 'apply' | 'fail' | 'dispose';
type Stage = 'transpilation' | 'evaluation';

type TManagerOptions = {
  /**
   * Whether the parent window has its own file resolver that can be used by the manager to resolve files
   */
  hasFileResolver: boolean;
};

export default class Manager {
  id: string;
  transpiledModules: {
    [path: string]: {
      module: Module;
      tModules: {
        [query: string]: TranspiledModule;
      };
    };
  };

  envVariables: { [envName: string]: string } = {};
  preset: Preset;
  externals: Externals;
  modules: ModuleObject;
  manifest: Manifest;
  dependencies: Object;
  webpackHMR: boolean;
  hardReload: boolean;
  hmrStatus: HMRStatus = 'idle';
  hmrStatusChangeListeners: Set<(status: HMRStatus) => void>;
  testRunner: TestRunner;
  isFirstLoad: boolean;

  fileResolver: IFileResolver | undefined;

  // List of modules that are being transpiled, to prevent duplicate jobs.
  transpileJobs: { [transpiledModuleId: string]: true };
  transpiledModulesByHash: { [hash: string]: TranspiledModule };

  // All paths are resolved at least twice: during transpilation and evaluation.
  // We can improve performance by almost 2x in this scenario if we cache the lookups
  cachedPaths: { [path: string]: { [path: string]: string } };

  configurations: ParsedConfigurationFiles;

  stage: Stage;

  constructor(
    id: string,
    preset: Preset,
    modules: { [path: string]: Module },
    options: TManagerOptions,
    cb?: Function
  ) {
    this.id = id;
    this.preset = preset;
    this.transpiledModules = {};
    this.cachedPaths = {};
    this.transpileJobs = {};
    this.webpackHMR = false;
    this.hardReload = false;
    this.hmrStatus = 'idle';
    this.hmrStatusChangeListeners = new Set();
    this.isFirstLoad = true;
    this.transpiledModulesByHash = {};
    this.configurations = {};
    this.stage = 'transpilation';

    this.modules = modules;
    Object.keys(modules).forEach(k => this.addModule(modules[k]));
    this.testRunner = new TestRunner(this);

    getGlobal().manager = this;
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.log(this);
    }

    BrowserFS.configure(
      {
        fs: 'CodeSandboxFS',
        options: {
          manager: this.bfsWrapper,
        },
      },
      () => {
        if (cb) {
          cb();
        }
      }
    );

    if (options.hasFileResolver) {
      this.setupFileResolver();
    }
  }

  setupFileResolver() {
    const protocol = new Protocol('file-resolver', () => true, window.parent);
    this.fileResolver = {
      protocol,
      isFile: (path: string) =>
        protocol.sendMessage<boolean>({ m: 'isFile', p: path }),
      readFile: (path: string) =>
        protocol.sendMessage<string>({ m: 'readFile', p: path }),
    };
  }

  bfsWrapper = {
    getTranspiledModules: () => this.transpiledModules,
    addModule: (module: Module) => {
      this.addModule(module);
    },
    removeModule: (module: Module) => {
      this.removeModule(module);
    },
    moveModule: (module: Module, newPath: string) => {
      this.moveModule(module, newPath);
    },
    updateModule: (module: Module) => {
      this.updateModule(module);
    },
  };

  resetAllModules() {
    this.getTranspiledModules().forEach(t => {
      t.resetTranspilation();
      t.resetCompilation();
    });
  }

  // Hoist these 2 functions to the top, since they get executed A LOT
  isFile = (p: string, cb: Function | undefined, c: Function) => {
    const callback = c || cb;
    const hasCallback = typeof callback === 'function';

    let returnValue;
    if (this.stage === 'transpilation') {
      // In transpilation phase we can afford to download the file if not found,
      // because we're async. That's why we also include the meta here.
      returnValue = this.transpiledModules[p] || combinedMetas[p];
    } else {
      returnValue = this.transpiledModules[p];
    }

    if (returnValue == null && hasCallback && this.fileResolver) {
      return this.fileResolver.isFile(p).then(bool => {
        callback(null, Boolean(bool));
      });
    }

    return hasCallback
      ? callback(null, Boolean(returnValue))
      : Boolean(returnValue);
  };

  readFileSync = (p: string, cb: Function | undefined, c?: Function) => {
    const callback = c || cb;
    const hasCallback = typeof callback === 'function';

    if (this.transpiledModules[p]) {
      const { code } = this.transpiledModules[p].module;

      return hasCallback ? callback(null, code) : code;
    }
    if (hasCallback && this.fileResolver) {
      return this.fileResolver.readFile(p).then(code => {
        this.addModule({ code, path: p });

        callback(code);
      });
    }

    const err = new Error('Could not find ' + p);
    // @ts-ignore
    err.code = 'ENOENT';

    if (hasCallback) {
      return callback(err);
    }
    throw err;
  };

  setStage = (stage: Stage) => {
    this.stage = stage;
  };

  setManifest(manifest?: Manifest) {
    this.manifest = manifest || {
      contents: {},
      dependencies: [],
      dependencyDependencies: {},
      dependencyAliases: {},
    };

    Object.keys(this.manifest.contents).forEach(path => {
      const module: Module = {
        path,
        code: this.manifest.contents[path].content,
      };

      if (SKIPPED_BROWSER_FIELD_DEPENDENCIES[path]) {
        const pJsonCode = JSON.parse(this.manifest.contents[path].content);
        // eslint-disable-next-line
        delete pJsonCode.browser;
        module.code = JSON.stringify(pJsonCode, null, 2);
      }

      // Check if module syntax, only transpile when that's NOT the case
      // TODO move this check to the packager
      if (!shouldTranspile(module.code, path)) {
        module.requires = this.manifest.contents[path].requires;
      }

      this.addModule(module);
    });
    debug(`Loaded manifest.`);
  }

  evaluateModule(
    module: Module,
    { force, testGlobals }: { force?: boolean; testGlobals?: boolean } = {
      force: false,
      testGlobals: false,
    }
  ) {
    if (this.hardReload && !this.isFirstLoad) {
      // Do a hard reload
      document.location.reload();
      return {};
    }

    // Evaluate the *changed* HMR modules first
    this.getTranspiledModules()
      .filter(t => t.hmrConfig && t.hmrConfig.isDirty())
      .forEach(t => t.evaluate(this));

    const transpiledModule = this.getTranspiledModule(module);

    if (force && transpiledModule.compilation) {
      transpiledModule.compilation = null;
    }

    try {
      const exports = this.evaluateTranspiledModule(
        transpiledModule,
        undefined,
        { force, testGlobals }
      );

      this.setHmrStatus('idle');

      return exports;
    } finally {
      // Run post evaluate
      this.getTranspiledModules().forEach(t => t.postEvaluate(this));
    }
  }

  evaluateTranspiledModule(
    transpiledModule: TranspiledModule,
    initiator?: TranspiledModule,
    {
      force = false,
      testGlobals = false,
    }: { force?: boolean; testGlobals?: boolean } = {}
  ) {
    if (force && transpiledModule.compilation) {
      transpiledModule.compilation = null;
    }

    return transpiledModule.evaluate(this, { force, testGlobals }, initiator);
  }

  addModule(module: Module) {
    this.transpiledModules[module.path] = this.transpiledModules[
      module.path
    ] || { module, tModules: {} };
  }

  addTranspiledModule(module: Module, query: string = ''): TranspiledModule {
    if (!this.transpiledModules[module.path]) {
      this.addModule(module);
    }
    this.transpiledModules[module.path].module = module;

    const transpiledModule = new TranspiledModule(module, query);
    this.transpiledModules[module.path].tModules[query] = transpiledModule;
    this.transpiledModulesByHash[transpiledModule.hash] = transpiledModule;

    return transpiledModule;
  }

  getTranspiledModuleByHash(hash: string) {
    return this.transpiledModulesByHash[hash];
  }

  /**
   * Get Transpiled Module from the registry, if there is no transpiled module
   * in the registry it will create a new one.
   *
   * @param {Module} module
   * @param {string} query A webpack like syntax (!url-loader)
   */
  getTranspiledModule(module: Module, query: string = ''): TranspiledModule {
    const moduleObject = this.transpiledModules[module.path];
    if (!moduleObject) {
      this.addModule(module);
    }

    let transpiledModule = this.transpiledModules[module.path].tModules[query];

    if (!transpiledModule) {
      transpiledModule = this.addTranspiledModule(module, query);
    }

    return transpiledModule;
  }

  /**
   * One module can have multiple transpiled modules, because modules can be
   * required in different ways. For example, require(`babel-loader!./Test.vue`) isn't
   * the same as require(`./Test.vue`).
   *
   * This will return all transpiled modules, with different configurations associated one module.
   * @param {*} module
   */
  getTranspiledModulesByModule(module: Module): Array<TranspiledModule> {
    return this.transpiledModules[module.path]
      ? values(this.transpiledModules[module.path].tModules)
      : [];
  }

  getTranspiledModules() {
    return values(this.transpiledModulesByHash);
  }

  removeTranspiledModule(tModule: TranspiledModule) {
    delete this.transpiledModulesByHash[tModule.hash];
    delete this.transpiledModules[tModule.module.path].tModules[tModule.query];
  }

  removeModule(module: Module) {
    // Reset all cached paths because file structure changed
    this.cachedPaths = {};

    const existingModule = this.transpiledModules[module.path];

    values(existingModule.tModules).forEach(m => {
      m.dispose(this);
      this.removeTranspiledModule(m);
    });

    delete this.transpiledModules[module.path];
  }

  moveModule(module: Module, newPath: string) {
    this.removeModule(module);
    this.addModule({ ...module, path: newPath });
  }

  setEnvironmentVariables() {
    if (this.transpiledModules['/.env'] && this.preset.hasDotEnv) {
      const envCode = this.transpiledModules['/.env'].module.code;

      this.envVariables = {};
      try {
        envCode.split('\n').forEach(envLine => {
          const [name, ...val] = envLine.split('=');

          this.envVariables[name] = val.join('=');
        });
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * Will transpile this module and all eventual children (requires) that go with it
   * @param {*} entry
   */
  async transpileModules(entry: Module, isTestFile: boolean = false) {
    this.setHmrStatus('check');
    this.setEnvironmentVariables();
    const transpiledModule = this.getTranspiledModule(entry);

    transpiledModule.setIsEntry(true);
    transpiledModule.setIsTestFile(isTestFile);

    const result = await transpiledModule.transpile(this);
    this.getTranspiledModules().forEach(t => t.postTranspile(this));

    return result;
  }

  verifyTreeTranspiled() {
    return Promise.all(
      this.getTranspiledModules()
        .filter(tModule => tModule.shouldTranspile())
        .map(tModule => tModule.transpile(this))
    );
  }

  clearCompiledCache() {
    this.getTranspiledModules().map(tModule => tModule.resetCompilation());
  }

  getModules(): Array<Module | ChildModule> {
    return values(this.transpiledModules).map(t => t.module);
  }

  /**
   * The packager returns a list of dependencies that require a different path
   * of their subdependencies.
   *
   * An example:
   * if react requires lodash v3, and react-dom requires lodash v4. We add them
   * both to the bundle, and rewrite paths for lodash v3 to `lodash/3.0.0/`. Then
   * we specify that when react resolves `lodash` it should resolve `lodash/3.0.0`.
   *
   * @param {string} path
   * @param {string} currentPath
   * @returns
   * @memberof Manager
   */
  getAliasedDependencyPath(path: string, currentPath: string) {
    const isDependency = /^(\w|@\w)/.test(path);

    if (!isDependency) {
      return path;
    }

    const isCurrentPathDependency = currentPath.startsWith('/node_modules');
    if (!isCurrentPathDependency) {
      return path;
    }

    const dependencyName = getDependencyName(path);
    const previousDependencyName = getDependencyName(
      currentPath.replace('/node_modules/', '')
    );

    if (
      this.manifest.dependencyAliases[previousDependencyName] &&
      this.manifest.dependencyAliases[previousDependencyName][dependencyName]
    ) {
      const aliasedDependencyName = this.manifest.dependencyAliases[
        previousDependencyName
      ][dependencyName];

      return path.replace(dependencyName, aliasedDependencyName);
    }

    return path;
  }

  /**
   * Set the manager to use Webpack HMR, this changes how modules are hot reloaded
   * and how the manager cleans up the website.
   *
   * @memberof Manager
   */
  enableWebpackHMR() {
    this.webpackHMR = true;
  }

  getPresetAliasedPath(path: string) {
    return this.preset
      .getAliasedPath(path)
      .replace(/.*\{\{sandboxRoot\}\}/, '');
  }

  getModuleDirectories() {
    const baseTSCompilerConfig = [
      this.configurations.typescript,
      this.configurations.jsconfig,
    ].find(config => config && config.generated !== true);

    const baseUrl =
      baseTSCompilerConfig &&
      baseTSCompilerConfig.parsed &&
      baseTSCompilerConfig.parsed.compilerOptions &&
      baseTSCompilerConfig.parsed.compilerOptions.baseUrl;

    return ['node_modules', baseUrl, this.envVariables.NODE_PATH].filter(
      Boolean
    );
  }

  // ALWAYS KEEP THIS METHOD IN SYNC WITH SYNC VERSION
  async resolveModuleAsync(
    path: string,
    currentPath: string,
    defaultExtensions = ['js', 'jsx', 'json']
  ): Promise<Module> {
    return new Promise(promiseResolve => {
      const dirredPath = pathUtils.dirname(currentPath);
      if (this.cachedPaths[dirredPath] === undefined) {
        this.cachedPaths[dirredPath] = {};
      }

      const cachedPath = this.cachedPaths[dirredPath][path];

      let resolvedPath;

      if (cachedPath) {
        resolvedPath = cachedPath;
      } else {
        const presetAliasedPath = this.getPresetAliasedPath(path);

        const aliasedPath = this.getAliasedDependencyPath(
          presetAliasedPath,
          currentPath
        );
        const shimmedPath = coreLibraries[aliasedPath] || aliasedPath;

        if (NODE_LIBS.indexOf(shimmedPath) > -1) {
          this.cachedPaths[dirredPath][path] = shimmedPath;
          promiseResolve(getShimmedModuleFromPath(currentPath, path));
          return;
        }

        try {
          resolve(
            shimmedPath,
            {
              filename: currentPath,
              extensions: defaultExtensions.map(ext => '.' + ext),
              isFile: this.isFile,
              readFileSync: this.readFileSync,
              packageFilter,
              moduleDirectory: this.getModuleDirectories(),
            },
            (err, foundPath) => {
              if (err) {
                throw err;
              }

              this.cachedPaths[dirredPath][path] = foundPath;

              if (foundPath === '//empty.js') {
                promiseResolve(getShimmedModuleFromPath(currentPath, path));
                return;
              }

              if (!this.transpiledModules[foundPath]) {
                this.readFileSync(foundPath, code => {
                  this.addModule({ path: foundPath, code });
                  promiseResolve(this.transpiledModules[foundPath].module);
                });
              } else {
                promiseResolve(this.transpiledModules[foundPath].module);
              }
            }
          );
        } catch (e) {
          if (
            this.cachedPaths[dirredPath] &&
            this.cachedPaths[dirredPath][path]
          ) {
            delete this.cachedPaths[dirredPath][path];
          }

          let connectedPath = shimmedPath;
          if (connectedPath.indexOf('/node_modules') !== 0) {
            connectedPath = /^(\w|@\w)/.test(shimmedPath)
              ? pathUtils.join('/node_modules', shimmedPath)
              : pathUtils.join(pathUtils.dirname(currentPath), shimmedPath);
          }

          const isDependency = connectedPath.includes('/node_modules/');

          connectedPath = connectedPath.replace('/node_modules/', '');

          if (!isDependency) {
            throw new ModuleNotFoundError(shimmedPath, false, currentPath);
          }

          const dependencyName = getDependencyName(connectedPath);

          if (
            this.manifest.dependencies.find(d => d.name === dependencyName) ||
            this.manifest.dependencyDependencies[dependencyName]
          ) {
            throw new ModuleNotFoundError(connectedPath, true, currentPath);
          } else {
            throw new DependencyNotFoundError(connectedPath, currentPath);
          }
        }
      }
      promiseResolve(this.transpiledModules[resolvedPath].module);
    });
  }

  // ALWAYS KEEP THIS METHOD IN SYNC WITH ASYNC VERSION
  resolveModule(
    path: string,
    currentPath: string,
    defaultExtensions: Array<string> = ['js', 'jsx', 'json']
  ): Module {
    const dirredPath = pathUtils.dirname(currentPath);
    if (this.cachedPaths[dirredPath] === undefined) {
      this.cachedPaths[dirredPath] = {};
    }

    const cachedPath = this.cachedPaths[dirredPath][path];

    let resolvedPath;

    if (cachedPath && this.transpiledModules[cachedPath]) {
      resolvedPath = cachedPath;
    } else {
      const presetAliasedPath = this.getPresetAliasedPath(path);

      const aliasedPath = this.getAliasedDependencyPath(
        presetAliasedPath,
        currentPath
      );
      const shimmedPath = coreLibraries[aliasedPath] || aliasedPath;

      if (NODE_LIBS.indexOf(shimmedPath) > -1) {
        this.cachedPaths[dirredPath][path] = shimmedPath;
        return getShimmedModuleFromPath(currentPath, path);
      }

      try {
        resolvedPath = resolve.sync(shimmedPath, {
          filename: currentPath,
          extensions: defaultExtensions.map(ext => '.' + ext),
          isFile: this.isFile,
          readFileSync: this.readFileSync,
          packageFilter,
          moduleDirectory: this.getModuleDirectories(),
        });

        this.cachedPaths[dirredPath][path] = resolvedPath;

        if (resolvedPath === '//empty.js') {
          return getShimmedModuleFromPath(currentPath, path);
        }

        if (!this.transpiledModules[resolvedPath]) {
          throw new Error(`Could not find '${resolvedPath}' in local files.`);
        }
      } catch (e) {
        // MAKE SURE TO SYNC THIS WITH ASYNC VERSION
        if (
          this.cachedPaths[dirredPath] &&
          this.cachedPaths[dirredPath][path]
        ) {
          delete this.cachedPaths[dirredPath][path];
        }

        let connectedPath = shimmedPath;
        if (connectedPath.indexOf('/node_modules') !== 0) {
          connectedPath = /^(\w|@\w)/.test(shimmedPath)
            ? pathUtils.join('/node_modules', shimmedPath)
            : pathUtils.join(pathUtils.dirname(currentPath), shimmedPath);
        }

        const isDependency = connectedPath.includes('/node_modules/');

        connectedPath = connectedPath.replace('/node_modules/', '');

        if (!isDependency) {
          throw new ModuleNotFoundError(shimmedPath, false, currentPath);
        }

        const dependencyName = getDependencyName(connectedPath);

        // TODO: fix the stack hack
        if (
          this.manifest.dependencies.find(d => d.name === dependencyName) ||
          this.manifest.dependencyDependencies[dependencyName]
        ) {
          throw new ModuleNotFoundError(connectedPath, true, currentPath);
        } else {
          throw new DependencyNotFoundError(connectedPath, currentPath);
        }
      }
    }

    if (resolvedPath === '//empty.js') {
      return getShimmedModuleFromPath(currentPath, path);
    }

    return this.transpiledModules[resolvedPath].module;
  }

  downloadDependency(
    path: string,
    currentTModule: TranspiledModule,
    query: string = '',
    ignoredExtensions: Array<string> = this.preset.ignoredExtensions
  ): Promise<TranspiledModule> {
    return fetchModule(
      path,
      currentTModule,
      this,
      ignoredExtensions
    ).then(module => this.getTranspiledModule(module, query));
  }

  updateModule(m: Module) {
    this.transpiledModules[m.path].module = m;
    return this.getTranspiledModulesByModule(m).map(tModule => {
      tModule.update(m);

      return tModule;
    });
  }

  resolveTranspiledModuleAsync = async (
    path: string,
    currentTModule?: TranspiledModule,
    ignoredExtensions?: Array<string>
  ): Promise<TranspiledModule> => {
    const tModule =
      currentTModule || this.getTranspiledModule(this.modules['/package.json']); // Get arbitrary file from root
    try {
      return Promise.resolve(
        this.resolveTranspiledModule(
          path,
          tModule.module.path,
          ignoredExtensions
        )
      );
    } catch (e) {
      if (e.type === 'module-not-found' && e.isDependency) {
        const { queryPath } = splitQueryFromPath(path);
        return this.downloadDependency(
          e.path,
          tModule,
          queryPath,
          ignoredExtensions
        );
      }

      throw e;
    }
  };

  setHmrStatus = (status: HMRStatus) => {
    this.hmrStatusChangeListeners.forEach(v => {
      v(status);
    });
    this.hmrStatus = status;
  };

  addStatusHandler = (cb: (status: HMRStatus) => void) => {
    this.hmrStatusChangeListeners.add(cb);
  };

  removeStatusHandler = (cb: (status: HMRStatus) => void) => {
    this.hmrStatusChangeListeners.delete(cb);
  };

  /**
   * Resolve the transpiled module from the path, note that the path can actually
   * include loaders. That's why we're focussing on first extracting this query
   * @param {*} path
   * @param {*} currentPath
   */
  resolveTranspiledModule(
    path: string,
    currentPath: string,
    ignoredExtensions: string[],
    async: true
  ): Promise<TranspiledModule>;

  resolveTranspiledModule(
    path: string,
    currentPath: string,
    ignoredExtensions?: string[],
    async?: false
  ): TranspiledModule;

  resolveTranspiledModule(
    path: string,
    currentPath: string,
    ignoredExtensions?: string[],
    async?: boolean
  ): Promise<TranspiledModule> | TranspiledModule {
    if (path.startsWith('webpack:')) {
      throw new Error('Cannot resolve webpack path');
    }

    const { queryPath, modulePath } = splitQueryFromPath(path);

    if (async) {
      return this.resolveModuleAsync(
        modulePath,
        currentPath,
        ignoredExtensions || this.preset.ignoredExtensions
      ).then(module => this.getTranspiledModule(module, queryPath));
    }

    const module = this.resolveModule(
      modulePath,
      currentPath,
      ignoredExtensions || this.preset.ignoredExtensions
    );

    return this.getTranspiledModule(module, queryPath);
  }

  resolveTranspiledModulesInDirectory(
    path: string,
    currentPath: string
  ): Array<TranspiledModule> {
    const { queryPath, modulePath } = splitQueryFromPath(path);

    const joinedPath = pathUtils.join(
      pathUtils.dirname(currentPath),
      modulePath
    );

    return Object.keys(this.transpiledModules)
      .filter(p => p.startsWith(joinedPath))
      .map(m =>
        this.getTranspiledModule(this.transpiledModules[m].module, queryPath)
      );
  }

  updateConfigurations(configurations: ParsedConfigurationFiles) {
    const configsUpdated = this.configurations
      ? JSON.stringify(configurations) !== JSON.stringify(this.configurations)
      : false;

    if (configsUpdated) {
      this.resetAllModules();
    }

    this.configurations = configurations;
  }

  /**
   * Find all changed, added and deleted modules. Update trees and
   * delete caches accordingly
   */
  async updateData(modules: {
    [path: string]: Module;
  }): Promise<Array<TranspiledModule>> {
    this.transpileJobs = {};
    this.hardReload = false;
    this.isFirstLoad = false;

    this.modules = modules;

    const addedModules: Array<Module> = [];
    const updatedModules: Array<Module> = [];

    Object.keys(modules).forEach(k => {
      const module: Module = modules[k];
      const mirrorModule = this.transpiledModules[k];

      if (!mirrorModule) {
        // File structure changed, reset cached paths
        this.cachedPaths = {};
        addedModules.push(module);
      } else if (mirrorModule.module.code !== module.code) {
        // File structure changed, reset cached paths
        this.cachedPaths = {};
        updatedModules.push(module);
      }
    });

    this.getModules().forEach(m => {
      if (
        !m.path.startsWith('/node_modules') &&
        m.path !== '/var/task/node_modules/browser-resolve/empty.js' &&
        !modules[m.path] &&
        !(m as ChildModule).parent // not an emitted module
      ) {
        this.removeModule(m);
      }
    });

    addedModules.forEach(m => {
      this.addTranspiledModule(m);
    });

    const modulesToUpdate: Array<Module> = uniq([
      ...addedModules,
      ...updatedModules,
    ]);

    // We eagerly transpile changed files,
    // this way we don't have to traverse the whole
    // dependency graph each time a file changes
    const tModulesToUpdate = modulesToUpdate.map(m => this.updateModule(m));

    if (tModulesToUpdate.length > 0 && this.configurations.sandbox) {
      this.hardReload = this.configurations.sandbox.parsed.hardReloadOnChange;
    }

    const modulesWithWErrors = this.getTranspiledModules().filter(t => {
      if (t.hasMissingDependencies) {
        t.resetTranspilation();
      }
      return t.errors.length > 0 || t.hasMissingDependencies;
    });
    const flattenedTModulesToUpdate = (flattenDeep([
      tModulesToUpdate,
      modulesWithWErrors,
    ]) as unknown) as TranspiledModule[];

    const allModulesToUpdate = uniq(flattenedTModulesToUpdate);
    const transpiledModulesToUpdate = allModulesToUpdate.filter(
      m => !m.isTestFile
    );

    // Reset test files, but don't transpile. We want to do that in the test runner
    // so we can catch any errors
    allModulesToUpdate
      .filter(m => m.isTestFile)
      .forEach(m => {
        m.resetTranspilation();
      });

    debug(
      `Generated update diff, updating ${transpiledModulesToUpdate.length} modules.`,
      transpiledModulesToUpdate
    );

    const transpilationResults = await Promise.all(
      transpiledModulesToUpdate
        .map(tModule => {
          if (tModule.shouldTranspile()) {
            return tModule.transpile(this);
          }

          return Promise.resolve(false);
        })
        .filter(Boolean) as Array<Promise<TranspiledModule>>
    );

    return transpilationResults;
  }

  /**
   * Mark that the next evaluation should first have a location.reload() before
   * continuing
   */
  markHardReload() {
    this.setHmrStatus('fail');
    this.hardReload = true;
  }

  async serialize(
    {
      entryPath,
      optimizeForSize,
    }: { entryPath?: string; optimizeForSize: boolean } = {
      optimizeForSize: true,
    }
  ) {
    const serializedTModules: { [id: string]: SerializedTranspiledModule } = {};

    await Promise.all(
      Object.keys(this.transpiledModules).map(path =>
        Promise.all(
          Object.keys(this.transpiledModules[path].tModules).map(
            async query => {
              const tModule = this.transpiledModules[path].tModules[query];

              if (
                !this.manifest.contents[tModule.module.path] ||
                (tModule.module.path.endsWith('.js') &&
                  tModule.module.requires == null) ||
                tModule.module.downloaded
              ) {
                // Only save modules that are not precomputed
                serializedTModules[tModule.getId()] = await tModule.serialize(
                  optimizeForSize
                );
              }
            }
          )
        )
      )
    );

    const dependenciesQuery = this.getDependencyQuery();

    const meta = {};
    Object.keys(combinedMetas || {}).forEach(p => {
      const dir = pathUtils.dirname(p.replace('/node_modules', ''));
      meta[dir] = meta[dir] || [];
      meta[dir].push(pathUtils.basename(p));
    });

    return {
      transpiledModules: serializedTModules,
      cachedPaths: this.cachedPaths,
      version: SCRIPT_VERSION,
      timestamp: new Date().getTime(),
      configurations: this.configurations,
      entry: entryPath,
      meta,
      dependenciesQuery,
    };
  }

  getDependencyQuery() {
    if (!this.manifest || !this.manifest.dependencies) {
      return '';
    }

    const normalizedDependencies = {};

    this.manifest.dependencies.forEach(dep => {
      normalizedDependencies[dep.name] = dep.version;
    });

    return dependenciesToQuery(normalizedDependencies);
  }

  async load(data: any) {
    try {
      if (data) {
        this.clearCache();
        const {
          transpiledModules: serializedTModules,
          cachedPaths,
          version,
          configurations,
          dependenciesQuery,
          meta,
        }: {
          transpiledModules: { [id: string]: SerializedTranspiledModule };
          cachedPaths: { [path: string]: { [path: string]: string } };
          version: string;
          timestamp: number;
          configurations: any;
          dependenciesQuery: string;
          meta: any;
        } = data;

        // Only use the cache if the cached version was cached with the same
        // version of the compiler and dependencies haven't changed
        if (
          version === SCRIPT_VERSION &&
          dependenciesQuery === this.getDependencyQuery()
        ) {
          const newCombinedMetas = {};
          Object.keys(meta).forEach(dir => {
            meta[dir].forEach(file => {
              newCombinedMetas[`/node_modules` + dir + '/' + file] = true;
            });
          });
          setCombinedMetas(newCombinedMetas);

          this.cachedPaths = cachedPaths;
          this.configurations = configurations;

          const tModules: { [id: string]: TranspiledModule } = {};
          // First create tModules for all the saved modules, so we have references
          Object.keys(serializedTModules).forEach(id => {
            const sTModule = serializedTModules[id];

            const tModule = this.addTranspiledModule(
              sTModule.module,
              sTModule.query
            );
            tModules[id] = tModule;
          });

          Object.keys(tModules).forEach(id => {
            const tModule = tModules[id];

            tModule.load(serializedTModules[id], tModules, this);
          });
          debug(`Loaded cache.`);
        }
      }
    } catch (e) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('Problems parsing cache');
        console.warn(e);
      }
    }
    this.clearCache();
  }

  dispose() {
    if (this.preset) {
      this.preset.transpilers.forEach(t => {
        if (t.dispose) {
          t.dispose();
        }
      });

      if (this.fileResolver) {
        this.fileResolver.protocol.dispose();
      }
    }
  }

  deleteAPICache() {
    ignoreNextCache();
    return deleteAPICache(this.id);
  }

  async clearCache() {
    try {
      await clearIndexedDBCache();
    } catch (ex) {
      if (process.env.NODE_ENV === 'development') {
        console.error(ex);
      }
    }
  }

  /**
   * Get information about all transpilers currently registered for this manager
   */
  async getTranspilerContext() {
    const info = {};

    const data = await Promise.all(
      Array.from(this.preset.transpilers).map(t =>
        t
          .getTranspilerContext(this)
          .then(context => ({ name: t.name, data: context }))
      )
    );

    data.forEach(t => {
      info[t.name] = t.data;
    });

    return info;
  }
}

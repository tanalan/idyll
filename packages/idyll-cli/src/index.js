const fs = require('fs');
const { dirname, isAbsolute, join, parse } = require('path');
const path = require('path');
const EventEmitter = require('events');
const changeCase = require('change-case');
const mkdirp = require('mkdirp');

const pathBuilder = require('./path-builder');
const configureNode = require('./node-config');
const pipeline = require('./pipeline');
const { ComponentResolver, DataResolver, CSSResolver } = require('./resolvers');

const debug = require('debug')('idyll:cli');

function createDirectories(paths) {
  mkdirp.sync(paths.OUTPUT_DIR);
  mkdirp.sync(paths.STATIC_OUTPUT_DIR);
  mkdirp.sync(paths.TMP_DIR);
}

const idyll = (options = {}, cb) => {
  const opts = Object.assign(
    {},
    {
      alias: {},
      watch: false,
      open: true,
      datasets: 'data',
      minify: true,
      ssr: true,
      components: 'components',
      static: 'static',
      defaultComponents: dirname(require.resolve('idyll-components')),
      layout: 'centered',
      theme: 'github',
      output: 'build',
      outputCSS: 'idyll_styles.css',
      outputJS: 'idyll_index.js',
      port: process.env.PORT || 3000,
      temp: '.idyll',
      template: join(__dirname, 'client', '_index.html'),
      transform: [],
      compiler: {}
    },
    options
  );
  if (opts.watch) opts.minify = false; // speed!

  const paths = pathBuilder(opts);
  debug('Reading from paths:', paths);

  createDirectories(paths);
  configureNode(paths);

  const inputPackage = fs.existsSync(paths.PACKAGE_FILE)
    ? require(paths.PACKAGE_FILE)
    : {};
  const inputConfig = inputPackage.idyll || {};

  // Handle options that can be provided via options or via package.json
  opts.alias = options.alias || inputConfig.alias || opts.alias;
  opts.transform = options.transform || inputConfig.transform || opts.transform;
  opts.compiler = options.compiler || inputConfig.compiler || opts.compiler;
  opts.context = options.context || inputConfig.context || opts.context;

  // Resolve compiler plugins:
  if (opts.compiler.postProcessors) {
    opts.compiler.postProcessors = opts.compiler.postProcessors.map(
      processor => {
        try {
          return require(processor, { basedir: paths.INPUT_DIR });
        } catch (e) {
          console.log(e);
          console.warn('\n\nCould not find post-processor plugin: ', processor);
        }
      }
    );
  }

  // Resolve context:
  if (opts.context) {
    if (opts.context.indexOf('./') > -1) {
      opts.context = join(paths.INPUT_DIR, opts.context);
    }
  }

  let bs;
  let watchers;

  const createResolvers = () => {
    return new Map([
      ['components', new ComponentResolver(opts, paths)],
      ['css', new CSSResolver(opts, paths)],
      ['data', new DataResolver(opts, paths)]
    ]);
  };

  class IdyllInstance extends EventEmitter {
    getPaths() {
      return paths;
    }

    getOptions() {
      return opts;
    }

    build(src) {
      // Resolvers are recreated on each build, since new data dependencies might have been added.
      const resolvers = createResolvers();

      if (src) opts.inputString = src;

      debug('Starting the build');
      // Leaving the following timing statement in for backwards-compatibility.
      if (opts.debug) console.time('Build Time');

      pipeline
        .build(opts, paths, resolvers)
        .then(output => {
          debug('Build completed');
          // Leaving the following timing statement in for backwards-compatibility.
          if (opts.debug) console.timeEnd('Build Time');
          this.emit('update', output);
        })
        .then(() => {
          if (!bs && opts.watch && opts.inputFile) {
            bs = require('browser-sync').create();
            // any time an input files changes we will recompile .idl source
            // and write ast.json, components.js, and data.js to disk
            watchers = [
              bs.watch(paths.IDYLL_INPUT_FILE, { ignoreInitial: true }, () =>
                inst.build()
              ),
              // that will cause watchify to rebuild so we just watch the output bundle file
              // and reload when it is updated. Watch options are to prevent multiple change
              // events since the bundle file can be somewhat large
              bs.watch(
                paths.JS_OUTPUT_FILE,
                { awaitWriteFinish: { stabilityThreshold: 499 } },
                bs.reload
              ),
              // when CSS changes we reassemble and inject it
              bs.watch(paths.CSS_INPUT_FILE, { ignoreInitial: true }, () => {
                pipeline.updateCSS(paths, resolvers.get('css')).then(() => {
                  bs.reload('styles.css');
                });
              }),
              // when any static files change we do a full rebuild.
              bs.watch(paths.STATIC_DIR, { ignoreInitial: true }, () =>
                inst.build()
              )
            ];

            // Each resolver is responsible for generating a list of directories to watch for
            // their corresponding data types.
            resolvers.forEach((resolver, name) => {
              let watcher = bs.watch(
                resolver.getDirectories(),
                { ignoreInitial: true },
                () => {
                  inst.build();
                }
              );
              watchers.push(watcher);
            });

            bs.init({
              cors: true,
              logLevel: 'warn',
              logPrefix: 'Idyll',
              notify: false,
              server: [paths.OUTPUT_DIR],
              ui: false,
              port: opts.port,
              open: opts.open
            });
          }
        })
        .then(() => {
          this.emit('complete');
        })
        .catch(error => {
          // pass along errors if anyone is listening
          if (this.listenerCount('error')) {
            this.emit('error', error);
          } else {
            // otherwise dump to the console
            console.error(error);
          }
        });
      return this;
    }

    // Returns an array of the default components
    // Each element of the array is an object with keys 'name' and 'path'
    // 'name' is the file name of the component
    // 'path' is the absolute path to the component
    getComponents() {
      var components = [];
      var defaultCompsDir = this.getPaths().DEFAULT_COMPONENT_DIRS;
      var compsDir = this.getComponentsDirectory(); // grabs the `components` folder of their current directory
      var componentDirs = [defaultCompsDir, compsDir];

      componentDirs.forEach(dirs => {
        dirs.forEach(dir => {
          try {
            fs.statSync(dir);
          } catch (error) {
            // for when directory doesn't exist
            return;
          }
          fs.readdirSync(dir + '').forEach(file => {
            var compName = file.replace(/\.jsx?/g, '');
            if (compName !== 'index') {
              // avoid conflicts with index.js file
              components.push({
                name: compName,
                path: dir + '/' + file
              });
            }
          });
        });
      });
      return components;
    }

    // Returns the directory of the `components` folder
    // of this IdyllInstance
    // Note: this isn't guaranteed to exist
    // It just adds "component" to the directory of this idyll instance
    getComponentsDirectory() {
      return this.getPaths().COMPONENT_DIRS;
    }

    // Adds the given component (directory) to the components used
    // in this IdyllInstance
    // If there is already a component for the given componentPath,
    // it will be overwritten with the one from componentPath
    // If there is no components/ directory, then it will be created
    addComponent(componentPath) {
      const componentsDirectory = this.getComponentsDirectory();
      // We grab the name of the component, and put that in the components directory
      const componentFileName = path.basename(componentPath);
      // ensure components directory exists
      try {
        fs.statSync(componentsDirectory[0]);
      } catch (err) {
        fs.mkdirSync(componentsDirectory[0]);
      }
      fs.copyFileSync(
        componentPath,
        componentsDirectory[0] + '/' + componentFileName
      );
    }

    // Returns an array of the current datasets used in this IdyllInstance's data directory
    getDatasets() {
      var dataFolder = this.getPaths().DATA_DIR;
      var defaultData = [];
      fs.readdirSync(dataFolder).forEach(file => {
        var fileName = file;
        var datasetPath = dataFolder + '/' + file;
        var extension = path.extname(file);
        defaultData.push({
          name: fileName,
          path: datasetPath,
          extension: extension
        });
      });
      return defaultData;
    }

    // Adds a dataset to the current datasets used in this IdyllInstance
    // It will be added to the `data` directory of this IdyllInstance
    addDataset(datasetPath) {
      const datasetDirectory = this.getPaths().DATA_DIR;
      const datasetName = path.basename(datasetPath);
      try {
        fs.statSync(datasetDirectory);
      } catch (err) {
        fs.mkdirSync(datasetDirectory);
      }
      fs.copyFileSync(datasetPath, datasetDirectory + '/' + datasetName);
    }

    stopWatching() {
      if (watchers.length) {
        watchers.forEach(w => w.close());
        watchers = null;
      }
      if (bs) bs.exit();
    }
  }

  const inst = new IdyllInstance();

  return inst;
};

module.exports = idyll;

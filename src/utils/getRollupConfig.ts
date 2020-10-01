/* eslint-disable no-lonely-if */
// require('dotenv').config();
import svelte from 'rollup-plugin-svelte';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import { terser } from 'rollup-plugin-terser';
import babel from 'rollup-plugin-babel';
import css from 'rollup-plugin-css-only';
import multiInput from 'rollup-plugin-multi-input';
import externalGlobals from 'rollup-plugin-external-globals';
import replace from '@rollup/plugin-replace';
import json from '@rollup/plugin-json';
import glob from 'glob';
import path from 'path';
import fs from 'fs-extra';
import del from 'del';
import { getElderConfig, partialHydration } from '../index';
import { ConfigOptions, RollupConfig } from './types';

const production = process.env.NODE_ENV === 'production' || !process.env.ROLLUP_WATCH;

const babelIE11 = babel({
  cwd: path.resolve(process.cwd(), './node_modules/@elderjs/elderjs/'),
  extensions: ['.js', '.mjs', '.html', '.svelte'],
  runtimeHelpers: true,
  exclude: ['node_modules/@babel/**', 'node_modules/core-js/**'],
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {
          browsers: ['> 0.25%', 'not dead', 'IE 11'],
        },
        useBuiltIns: 'usage',
        corejs: 3,
      },
    ],
  ],
});

export function createBrowserConfig({
  input,
  output,
  multiInputConfig,
  svelteConfig,
  rollupConfig = {} as RollupConfig,
  ie11 = false as boolean,
}) {
  let replacements = {
    'process.env.componentType': "'browser'",
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
  };
  if (rollupConfig && rollupConfig.replacements) {
    replacements = {
      ...replacements,
      ...rollupConfig.replacements,
    };
  }

  const config = {
    cache: true,
    treeshake: production,
    input,
    output,
    plugins: [
      replace(replacements),
      json(),
      svelte({
        ...svelteConfig,
        dev: !production,
        immutable: true,
        hydratable: true,
        css: false,
      }),
      nodeResolve({
        browser: true,
        dedupe: ['svelte'],
        preferBuiltins: true,
      }),
      commonjs({ sourceMap: !production }),
    ],
  };

  // bundle splitting.
  if (multiInputConfig) {
    config.plugins.unshift(multiInputConfig);
  }
  // if is production let's babelify everything and minify it.
  if (production) {
    config.plugins.push(
      babel({
        extensions: ['.js', '.mjs', '.cjs', '.html', '.svelte'],
        include: ['node_modules/**', 'src/**'],
        exclude: ['node_modules/@babel/**'],
        runtimeHelpers: true,
      }),
    );
    config.plugins.push(terser());
  }

  if (ie11) {
    config.plugins.push(babelIE11);
  }

  return config;
}

export function createSSRConfig({
  input,
  output,
  svelteConfig,
  rollupConfig = {} as RollupConfig,
  multiInputConfig = false,
}) {
  let replacements = {
    'process.env.componentType': "'server'",
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
  };
  if (rollupConfig && rollupConfig.replacements) {
    replacements = {
      ...replacements,
      ...rollupConfig.replacements,
    };
  }
  const config = {
    cache: true,
    treeshake: production,
    input,
    output,
    plugins: [
      replace(replacements),
      json(),
      svelte({
        ...svelteConfig,
        dev: !production,
        hydratable: true,
        generate: 'ssr',
        css: true,
        extensions: '.svelte',
        preprocess: [...svelteConfig.preprocess, partialHydration],
      }),

      nodeResolve({
        browser: false,
        dedupe: ['svelte'],
      }),
      commonjs({ sourceMap: true }),
      css({
        ignore: true,
      }),
      production && terser(),
    ],
  };
  // if we are bundle splitting include them.
  if (multiInputConfig) {
    config.plugins.unshift(multiInputConfig);
  }

  return config;
}

export function getPluginPaths(elderConfig: ConfigOptions) {
  const pluginNames = Object.keys(elderConfig.plugins);

  return pluginNames.reduce((out, pluginName) => {
    const pluginPath = path.resolve(elderConfig.srcDir, `./plugins/${pluginName}`);
    const nmPluginPath = path.resolve(elderConfig.rootDir, `./node_modules/${pluginName}`);
    if (fs.existsSync(`${pluginPath}/index.js`)) {
      const svelteFiles = glob.sync(`${pluginPath}/*.svelte`);
      if (svelteFiles.length > 0) {
        out.push(`${pluginPath}/`);
      }
    } else if (fs.existsSync(`${nmPluginPath}/package.json`)) {
      if (glob.sync(`${nmPluginPath}/*.svelte`).length > 0) {
        out.push(`${nmPluginPath}/`);
      }
    }
    return out;
  }, []);
}

export default function getRollupConfig({ svelteConfig = {}, rollupConfig = {} }) {
  const elderConfig = getElderConfig();
  const { $$internal, distDir, srcDir, rootDir } = elderConfig;
  const { ssrComponents, clientComponents } = $$internal;
  const relSrcDir = srcDir.replace(rootDir, '').substr(1);

  console.log(`Elder.js using rollup in ${production ? 'production' : 'development'} mode.`);

  let configs = [];

  // clear out components so there are no conflicts due to hashing.
  del.sync([`${ssrComponents}*`, `${clientComponents}*`]);

  // Add ElderJs Peer deps to public if they exist.
  [
    ['./node_modules/intersection-observer/intersection-observer.js', './static/intersection-observer.js'],
    ['./node_modules/systemjs/dist/s.min.js', './static/s.min.js'],
  ].forEach((dep) => {
    if (!fs.existsSync(path.resolve(rootDir, dep[0]))) {
      throw new Error(`Elder.js peer dependency not found at ${dep[0]}`);
    }
    configs.push({
      input: dep[0],
      output: [
        {
          file: path.resolve(distDir, dep[1]),
          format: 'iife',
          name: dep[1],
          plugins: [terser()],
        },
      ],
    });
  });

  const templates = createSSRConfig({
    input: [`${relSrcDir}/routes/*/*.svelte`, `${relSrcDir}/layouts/*.svelte`],
    output: {
      dir: ssrComponents,
      format: 'cjs',
      exports: 'auto',
    },
    multiInputConfig: multiInput({
      relative: `${relSrcDir}/`,
      transformOutputPath: (output) => `${path.basename(output)}`,
    }),
    svelteConfig,
    rollupConfig,
  });

  const pluginPaths = getPluginPaths(elderConfig);

  configs = [...configs, templates];

  configs.push(
    createBrowserConfig({
      input: [`${relSrcDir}/components/*/*.svelte`, `${relSrcDir}/components/*.svelte`],
      output: [
        {
          dir: clientComponents,
          entryFileNames: 'entry[name]-[hash].js',
          sourcemap: !production,
          format: 'system',
        },
        {
          dir: clientComponents,
          entryFileNames: 'entry[name]-[hash].mjs',
          sourcemap: !production,
          format: 'esm',
        },
      ],
      multiInputConfig: multiInput({
        relative: `${relSrcDir}/components`,
        transformOutputPath: (output) => `${path.basename(output)}`,
      }),
      svelteConfig,
      rollupConfig,
    }),
  );

  configs.push(
    createSSRConfig({
      input: [`${relSrcDir}/components/*/*.svelte`, `${relSrcDir}/components/*.svelte`],
      output: {
        dir: ssrComponents,
        format: 'cjs',
        exports: 'auto',
      },
      multiInputConfig: multiInput({
        relative: `${relSrcDir}/components`,
        transformOutputPath: (output) => `${path.basename(output)}`,
      }),
      svelteConfig,
      rollupConfig,
    }),
  );

  if (fs.existsSync(path.resolve(srcDir, `./components/`))) {
    [
      ...new Set([
        ...glob.sync(path.resolve(srcDir, './components/*/*.svelte')),
        ...glob.sync(path.resolve(srcDir, './components/*.svelte')),
      ]),
    ].forEach((cv) => {
      const file = cv.replace(`${rootDir}/`, '');
      const parsed = path.parse(cv);
      configs.push(
        createBrowserConfig({
          input: file,
          output: [
            {
              name: `___elderjs_${parsed.name}`,
              dir: clientComponents,
              entryFileNames: 'iife[name]-[hash].js',
              sourcemap: !production,
              format: 'iife',
            },
          ],
          svelteConfig,
          rollupConfig,
          multiInputConfig: false,
          ie11: true,
        }),
      );
    });
  }

  pluginPaths.forEach((pluginPath) => {
    configs.push(
      createBrowserConfig({
        input: [`${pluginPath}*.svelte`],
        output: [
          {
            dir: clientComponents,
            entryFileNames: 'entry[name]-[hash].js',
            sourcemap: !production,
            format: 'system',
          },
          {
            dir: clientComponents,
            entryFileNames: 'entry[name].mjs',
            sourcemap: !production,
            format: 'esm',
          },
        ],
        multiInputConfig: multiInput({
          relative: pluginPath.replace(elderConfig.distDir, '').substr(1),
          transformOutputPath: (output) => `${path.basename(output)}`,
        }),
        svelteConfig,
        rollupConfig,
      }),
    );

    configs.push(
      createSSRConfig({
        input: [`${pluginPath}*.svelte`],
        output: {
          dir: ssrComponents,
          format: 'cjs',
          exports: 'auto',
        },
        multiInputConfig: multiInput({
          relative: pluginPath.replace(elderConfig.distDir, '').substr(1),
          transformOutputPath: (output) => `${path.basename(output)}`,
        }),
        svelteConfig,
        rollupConfig,
      }),
    );
  });

  return configs;
}

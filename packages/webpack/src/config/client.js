import path from 'path'
import fs from 'fs'
import querystring from 'querystring'
import consola from 'consola'
import webpack from 'webpack'
import HTMLPlugin from 'html-webpack-plugin'
import BundleAnalyzer from 'webpack-bundle-analyzer'
import OptimizeCSSAssetsPlugin from 'optimize-css-assets-webpack-plugin'
import FriendlyErrorsWebpackPlugin from '@nuxt/friendly-errors-webpack-plugin'

import CorsPlugin from '../plugins/vue/cors'
import ModernModePlugin from '../plugins/vue/modern'
import VueSSRClientPlugin from '../plugins/vue/client'
import WebpackBaseConfig from './base'

export default class WebpackClientConfig extends WebpackBaseConfig {
  constructor(builder) {
    super(builder)
    this.name = 'client'
    this.isServer = false
    this.isModern = false
  }

  getFileName(...args) {
    if (this.buildContext.buildOptions.analyze) {
      const [key] = args
      if (['app', 'chunk'].includes(key)) {
        return `${this.isModern ? 'modern-' : ''}[name].js`
      }
    }
    return super.getFileName(...args)
  }

  env() {
    return Object.assign(super.env(), {
      'process.env.VUE_ENV': JSON.stringify('client'),
      'process.browser': true,
      'process.client': true,
      'process.server': false,
      'process.modern': false
    })
  }

  optimization() {
    const optimization = super.optimization()

    // Small, known and common modules which are usually used project-wise
    // Sum of them may not be more than 244 KiB
    if (
      this.buildContext.buildOptions.splitChunks.commons === true &&
      optimization.splitChunks.cacheGroups.commons === undefined
    ) {
      optimization.splitChunks.cacheGroups.commons = {
        test: /node_modules[\\/](vue|vue-loader|vue-router|vuex|vue-meta|core-js|@babel\/runtime|axios|webpack|setimmediate|timers-browserify|process|regenerator-runtime|cookie|js-cookie|is-buffer|dotprop|nuxt\.js)[\\/]/,
        chunks: 'all',
        priority: 10,
        name: true
      }
    }

    return optimization
  }

  minimizer() {
    const minimizer = super.minimizer()

    // https://github.com/NMFR/optimize-css-assets-webpack-plugin
    // https://github.com/webpack-contrib/mini-css-extract-plugin#minimizing-for-production
    // TODO: Remove OptimizeCSSAssetsPlugin when upgrading to webpack 5
    if (this.buildContext.buildOptions.optimizeCSS) {
      minimizer.push(
        new OptimizeCSSAssetsPlugin(Object.assign({}, this.buildContext.buildOptions.optimizeCSS))
      )
    }

    return minimizer
  }

  plugins() {
    const plugins = super.plugins()
    const { buildOptions } = this.buildContext

    // Generate output HTML for SSR
    if (buildOptions.ssr) {
      plugins.push(
        new HTMLPlugin({
          filename: '../server/index.ssr.html',
          template: this.buildContext.options.appTemplatePath,
          minify: buildOptions.html.minify,
          inject: false // Resources will be injected using bundleRenderer
        })
      )
    }

    plugins.push(
      new HTMLPlugin({
        filename: '../server/index.spa.html',
        template: this.buildContext.options.appTemplatePath,
        minify: buildOptions.html.minify,
        inject: true,
        chunksSortMode: 'dependency'
      }),
      new VueSSRClientPlugin({
        filename: `../server/${this.name}.manifest.json`
      }),
      new webpack.DefinePlugin(this.env())
    )

    if (this.dev) {
      // TODO: webpackHotUpdate is not defined: https://github.com/webpack/webpack/issues/6693
      plugins.push(new webpack.HotModuleReplacementPlugin())
    }

    // Webpack Bundle Analyzer
    // https://github.com/webpack-contrib/webpack-bundle-analyzer
    if (!this.dev && buildOptions.analyze) {
      const statsDir = path.resolve(this.buildContext.options.buildDir, 'stats')

      plugins.push(new BundleAnalyzer.BundleAnalyzerPlugin(Object.assign({
        analyzerMode: 'static',
        defaultSizes: 'gzip',
        generateStatsFile: true,
        openAnalyzer: !buildOptions.quiet,
        reportFilename: path.resolve(statsDir, `${this.name}.html`),
        statsFilename: path.resolve(statsDir, `${this.name}.json`)
      }, buildOptions.analyze)))
    }

    if (this.buildContext.options.modern) {
      plugins.push(new ModernModePlugin({
        targetDir: path.resolve(this.buildContext.options.buildDir, 'dist', 'client'),
        isModernBuild: this.isModern
      }))
    }

    if (buildOptions.crossorigin) {
      plugins.push(new CorsPlugin({
        crossorigin: buildOptions.crossorigin
      }))
    }

    // TypeScript type checker
    // Only performs once per client compilation and only if `ts-loader` checker is not used (transpileOnly: true)
    if (!this.isModern && this.loaders.ts.transpileOnly && buildOptions.useForkTsChecker) {
      const forkTsCheckerResolvedPath = this.buildContext.nuxt.resolver.resolveModule('fork-ts-checker-webpack-plugin')
      if (forkTsCheckerResolvedPath) {
        const ForkTsCheckerWebpackPlugin = require(forkTsCheckerResolvedPath)
        plugins.push(new ForkTsCheckerWebpackPlugin(Object.assign({
          vue: true,
          tsconfig: path.resolve(this.buildContext.options.rootDir, 'tsconfig.json'),
          // https://github.com/Realytics/fork-ts-checker-webpack-plugin#options - tslint: boolean | string - So we set it false if file not found
          tslint: (tslintPath => fs.existsSync(tslintPath) && tslintPath)(path.resolve(this.buildContext.options.rootDir, 'tslint.json')),
          formatter: 'codeframe',
          logger: consola
        }, buildOptions.useForkTsChecker)))
      } else {
        consola.warn('You need to install `fork-ts-checker-webpack-plugin` as devDependency to enable TypeScript type checking !')
      }
    }

    return plugins
  }

  config() {
    const config = super.config()

    const { client = {} } = this.buildContext.buildOptions.hotMiddleware || {}
    const { ansiColors, overlayStyles, ...options } = client
    const hotMiddlewareClientOptions = {
      reload: true,
      timeout: 30000,
      ansiColors: JSON.stringify(ansiColors),
      overlayStyles: JSON.stringify(overlayStyles),
      ...options,
      name: this.name
    }
    const clientPath = `${this.buildContext.options.router.base}/__webpack_hmr/${this.name}`
    const hotMiddlewareClientOptionsStr =
      `${querystring.stringify(hotMiddlewareClientOptions)}&path=${clientPath}`.replace(/\/\//g, '/')

    // Entry points
    config.entry = {
      app: [path.resolve(this.buildContext.options.buildDir, 'client.js')]
    }

    // Add HMR support
    if (this.dev) {
      config.entry.app.unshift(
        // https://github.com/webpack-contrib/webpack-hot-middleware/issues/53#issuecomment-162823945
        'eventsource-polyfill',
        // https://github.com/glenjamin/webpack-hot-middleware#config
        `webpack-hot-middleware/client?${hotMiddlewareClientOptionsStr}`
      )
    }

    // Add friendly error plugin
    if (this.dev && !this.buildContext.buildOptions.quiet && this.buildContext.buildOptions.friendlyErrors) {
      config.plugins.push(
        new FriendlyErrorsWebpackPlugin({
          clearConsole: false,
          reporter: 'consola',
          logLevel: 'WARNING'
        })
      )
    }

    return config
  }
}

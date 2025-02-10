import { defineNuxtConfig } from 'nuxt/config';
import istanbulPlugin from "vite-plugin-istanbul";

const appName = "VigiEau Admin";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  ssr: false,

  app: {
    head: {
      title: appName,
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content: `Plateforme d'administration ${appName}`,
        },
        { name: 'format-detection', content: 'telephone=no' },
        { property: 'og:title', content: appName },
        {
          property: 'og:description',
          content: `Plateforme d'administration ${appName}`,
        },
        { property: 'og:type', content: 'website' },
        { property: 'og:url', content: `https://${process.env.DOMAIN_NAME}` },
        { property: 'og:locale', content: 'fr_FR' },
        { property: 'og:image', content: `https://${process.env.DOMAIN_NAME}/favicon.svg` },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      htmlAttrs: {
        lang: 'fr',
      },
    },
  },

  buildModules: ['@nuxt/typescript-build'],

  css: [
    '@gouvfr/dsfr/dist/core/core.main.min.css',
    '@gouvfr/dsfr/dist/component/component.main.min.css',
    '@gouvfr/dsfr/dist/scheme/scheme.min.css',
    '@gouvfr/dsfr/dist/utility/utility.main.min.css',
    '@gouvminint/vue-dsfr/styles',
    'maplibre-gl/dist/maplibre-gl.css',

    'assets/main.scss',
  ],

  ignore: ['**/*.test.*', '**/*.spec.*', '**/*.cy.*'],
  srcDir: 'client/',

  imports: {
    autoImport: true,
  },

  modules: ['@pinia/nuxt', '@pinia-plugin-persistedstate/nuxt'],

  runtimeConfig: {
    public: {
      appName,
      isProd: process.env.IS_PROD,
      domainName: process.env.DOMAIN_NAME,
      apiUrl: process.env.API_URL,
      email: 'contact.vigieau@beta.gouv.fr',
    },
  },

  vite: {
    build: {
      target: 'es2019',
    },
    plugins: [
      istanbulPlugin({
        exclude: ['node_modules', 'test/', 'coverage/'],
        extension: [ '.js', '.ts', '.vue' ],
        cypress: true
      }),
    ]
  },

  nitro: {
    devProxy: {
      '/api/': {
        target: process.env.API_URL,
      },
    },
  },

  pinia: {
    storesDirs: ['./stores/**'],
  },

  hooks: {
    'build:manifest': (manifest) => {
      // Suppression du prefetch pour les icônes
      for (const key in manifest) {
        const file = manifest[key];

        if (file.assets) {
          file.assets = file.assets.filter(
            (asset: string) => !asset.endsWith('.webp') && !asset.endsWith('.jpg') && !asset.endsWith('.png') && !asset.endsWith('.svg'),
          );
        }
      }
    },
  },

  compatibilityDate: '2024-09-02',
});
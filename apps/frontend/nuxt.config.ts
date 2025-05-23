import {defineNuxtConfig} from 'nuxt/config'
import istanbul from "vite-plugin-istanbul";

const appName = `VigiEau`;

// https://v3.nuxtjs.org/api/configuration/nuxt.config
export default defineNuxtConfig({
    ssr: false,

    app: {
        head: {
            title: appName,
            meta: [
                {charset: 'utf-8'},
                {name: 'viewport', content: 'width=device-width, initial-scale=1'},
                {
                    name: 'description',
                    content: `Avec ${process.env.DOMAIN_NAME}, restez informés sur la situation locale de la sécheresse et adoptez les gestes les plus appropriés.`
                },
                {name: 'format-detection', content: 'telephone=no'},
                {property: 'og:title', content: appName},
                {
                    property: 'og:description',
                    content: `Avec ${process.env.DOMAIN_NAME}, restez informés sur la situation locale de la sécheresse et adoptez les gestes les plus appropriés.`
                },
                {property: 'og:type', content: 'website'},
                {property: 'og:url', content: `https://${process.env.DOMAIN_NAME}`},
                {property: 'og:locale', content: 'fr_FR'},
                {property: 'og:image', content: `https://${process.env.DOMAIN_NAME}/favicon.svg`},
            ],
            link: [
                {rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg'}
            ],
            htmlAttrs: {
                lang: 'fr'
            },
            script: [
                {
                    src: 'https://tally.so/widgets/embed.js',
                    async: true,
                    defer: true
                }
            ]
        }
    },

    css: [
        '@gouvfr/dsfr/dist/core/core.main.min.css',
        '@gouvfr/dsfr/dist/component/component.main.min.css',
        '@gouvfr/dsfr/dist/utility/icons/icons-system/icons-system.min.css',
        '@gouvminint/vue-dsfr/styles',
        'maplibre-gl/dist/maplibre-gl.css',

        'assets/main.scss'
    ],

    ignore: [
        '**/*.test.*',
        '**/*.spec.*',
        '**/*.cy.*',
    ],

    srcDir: 'client/',

    imports: {
        autoImport: true
    },

    modules: [
        '@pinia/nuxt',
        '@vite-pwa/nuxt',
        '@nuxtjs/sitemap',
        '@nuxtjs/robots',
        'vue-dsfr-nuxt-module'
    ],

    runtimeConfig: {
        public: {
            apiAdresseUrl: process.env.API_ADRESSE_URL,
            apiGeoUrl: process.env.API_GEO_URL,
            apiSecheresseUrl: process.env.API_SECHERESSE_URL,
            domainName: process.env.DOMAIN_NAME,
            domainProdNotActivated: process.env.DOMAIN_PROD_NOT_ACTIVATED,
            pmtilesUrl: process.env.PMTILES_URL,
            s3vhost: process.env.S3_VHOST,
            appName: appName,
            appEnv: process.env.APP_ENV,
            email: 'contact.vigieau@beta.gouv.fr',
            telephone: '01.40.81.35.14',
        }
    },

    vite: {
        build: {
            target: 'es2019'
        },
        plugins: [
            istanbul({
                include: 'client/*',
                exclude: ['node_modules', 'test/'],
                extension: ['.js', '.ts', '.vue'],
                requireEnv: false
            }),
        ]
    },

    hooks: {
        'build:manifest': (manifest) => {
            // Suppression du prefetch pour les icônes
            for (const key in manifest) {
                const file = manifest[key]

                if (file.assets) {
                    file.assets = file.assets
                        .filter(
                            (asset: string) =>
                                !asset.endsWith('.webp') &&
                                !asset.endsWith('.jpg') &&
                                !asset.endsWith('.png') &&
                                !asset.endsWith('.svg')
                        )
                }
            }
        }
    },

    //@ts-ignore
    pwa: {
        registerType: 'autoUpdate',
        manifest: {
            name: appName,
            short_name: appName,
            description: `Avec ${process.env.DOMAIN_NAME}, nous vous permettons de rester informé sur votre situation locale tout en vous partageant les conseils les plus appropriés.`,
            theme_color: '#ffffff',
            background_color: '#ffffff',
            lang: "fr",
            start_url: "./?utm_source=web_app_manifest",
            icons: [
                {
                    src: "/favicon.svg",
                    sizes: "any",
                    type: "image/svg+xml",
                    purpose: "any maskable"
                }
            ]
        },
        workbox: {
            navigateFallback: '/',
            cleanupOutdatedCaches: true,
            globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
            importScripts: ['/inject-sw.js']
        },
        client: {
            installPrompt: true,
        },
        devOptions: {
            enabled: false,
            type: 'module',
        },
    },

    robots: {
        disallow: process.env.APP_ENV === 'prod' ? '' : '/'
    },

    site: {
        url: `https://${process.env.DOMAIN_NAME}`
    },

    compatibilityDate: '2024-08-19'
})
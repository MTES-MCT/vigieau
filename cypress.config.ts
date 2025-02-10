import { defineConfig } from "cypress";
require('dotenv').config();

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
    setupNodeEvents(on, config) {
      require('@cypress/code-coverage/task')(on, config)
      // include any other plugin code...

      // It's IMPORTANT to return the config object
      // with any changed environment variables
      return config
    },
  },
  env: {
    apiUrl: process.env.API_URL,
    departementUser: '2A@test.fr',
    departementAciUser: '2B@test.fr',
    mteUser: 'mte@test.fr',
    // codeCoverage: {
    //   url: "http://localhost:3001/api/app/__coverage__"
    // }
  },
  defaultCommandTimeout: 10000,
  pageLoadTimeout: 10000,
});

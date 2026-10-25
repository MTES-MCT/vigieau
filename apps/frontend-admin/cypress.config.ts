import codeCoverageTask from '@cypress/code-coverage/task';
import { defineConfig } from "cypress";
import 'dotenv/config';

export default defineConfig({
  e2e: {
    baseUrl: "http://localhost:3000",
    setupNodeEvents(on, config) {
      codeCoverageTask(on, config)
      // include any other plugin code...

      // It's IMPORTANT to return the config object
      // with any changed environment variables
      return config
    },
  },
  env: {
    apiUrl: process.env.API_URL,
    departementUser: '2a@test.fr',
    departementAciUser: '2b@test.fr',
    mteUser: 'mte@test.fr',
    // codeCoverage: {
    //   url: "http://localhost:3001/api/app/__coverage__"
    // }
  },
  defaultCommandTimeout: 10000,
  pageLoadTimeout: 10000,
});

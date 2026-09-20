/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '\\.spec\\.ts$',
  setupFiles: ['reflect-metadata'],
  // The suite talks to a real MariaDB on purpose: the dedup and the row lock
  // ARE the implementation, so mocking the database would test nothing.
  testTimeout: 30_000,
};

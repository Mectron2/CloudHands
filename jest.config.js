export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  transform: {},
  collectCoverageFrom: ['dist/**/*.js', '!dist/index.js'],
  testTimeout: 20000,
};

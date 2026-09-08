/**
 * Vitest setup file - runs before all tests
 *
 * Sets required environment variables for test environment.
 */

// Miriad Cloud requires MIRIAD_RUNTIME_MODE to be set
// Use 'docker' for tests since it doesn't require external services
process.env.MIRIAD_RUNTIME_MODE = 'docker';

// Docker mode requires MIRIAD_CLOUD_IMAGE
process.env.MIRIAD_CLOUD_IMAGE = 'miriad-cloud:test';

/**
 * Chrome API mock for Jest tests.
 * Stubs the minimum chrome.* surface used by VoiceCast.
 * Imported via jest setupFiles before each test file runs.
 */

const storageData = {};

const chromeMock = {
  runtime: {
    sendMessage: jest.fn(),
    onMessage: {
      addListener: jest.fn(),
    },
    getURL: jest.fn((path) => `chrome-extension://test-extension-id/${path}`),
    getManifest: jest.fn(() => ({ version: '1.0.0', name: 'VoiceCast' })),
    lastError: null,
  },
  storage: {
    local: {
      get: jest.fn((keys, callback) => {
        if (typeof keys === 'string') {
          callback({ [keys]: storageData[keys] ?? null });
        } else if (Array.isArray(keys)) {
          const result = {};
          for (const k of keys) result[k] = storageData[k] ?? null;
          callback(result);
        } else {
          // null = get all
          callback({ ...storageData });
        }
      }),
      set: jest.fn((items, callback) => {
        Object.assign(storageData, items);
        if (callback) callback();
      }),
      remove: jest.fn((keys, callback) => {
        const ks = Array.isArray(keys) ? keys : [keys];
        for (const k of ks) delete storageData[k];
        if (callback) callback();
      }),
      clear: jest.fn((callback) => {
        Object.keys(storageData).forEach((k) => delete storageData[k]);
        if (callback) callback();
      }),
    },
    sync: {
      get: jest.fn((keys, callback) => callback({})),
      set: jest.fn((_items, callback) => { if (callback) callback(); }),
    },
  },
};

// Reset storage between tests
beforeEach(() => {
  Object.keys(storageData).forEach((k) => delete storageData[k]);
  jest.clearAllMocks();
  // Re-apply default implementations after clearAllMocks
  chromeMock.storage.local.get.mockImplementation((keys, callback) => {
    if (typeof keys === 'string') {
      callback({ [keys]: storageData[keys] ?? null });
    } else if (Array.isArray(keys)) {
      const result = {};
      for (const k of keys) result[k] = storageData[k] ?? null;
      callback(result);
    } else {
      callback({ ...storageData });
    }
  });
  chromeMock.storage.local.set.mockImplementation((items, callback) => {
    Object.assign(storageData, items);
    if (callback) callback();
  });
  chromeMock.storage.local.remove.mockImplementation((keys, callback) => {
    const ks = Array.isArray(keys) ? keys : [keys];
    for (const k of ks) delete storageData[k];
    if (callback) callback();
  });
  chromeMock.storage.local.clear.mockImplementation((callback) => {
    Object.keys(storageData).forEach((k) => delete storageData[k]);
    if (callback) callback();
  });
  chromeMock.runtime.lastError = null;
});

global.chrome = chromeMock;

// Expose storage data for test assertions
global.__chromeStorageData = storageData;

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * This module imports the reflect-metadata library which is needed by inversify. It was designed to
 * be imported near the start of all entrypoints that will utilize inversify.
 *
 * ESM imports run at module load time, so this import happens automatically when the module is first
 * loaded. The reflect-metadata library is safe to import multiple times - it checks internally whether
 * the global Reflect.metadata API has already been polyfilled and won't overwrite existing metadata.
 */
// Import reflect-metadata at the top level
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import 'reflect-metadata';

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * This module imports the reflect-metadata library which is needed by inversify. It was designed to
 * be imported near the start of all entrypoints that will utilize inversify.
 *
 * Note that we check if metadata is already defined because reflect-metadata may have been already
 * initialized by another extension running on the same extension host. If that happens, the old
 * metadata state would be clobbered.
 */
// Import reflect-metadata at the top level
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import 'reflect-metadata';

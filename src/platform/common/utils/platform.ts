// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export enum OSType {
    Unknown = 'Unknown',
    Windows = 'Windows',
    OSX = 'OSX',
    Linux = 'Linux'
}

// Return the OS type for the given platform string.
function getOSTypeImpl(platform: string = process.platform): OSType {
    if (/^win/.test(platform)) {
        return OSType.Windows;
    } else if (/^darwin/.test(platform)) {
        return OSType.OSX;
    } else if (/^linux/.test(platform)) {
        return OSType.Linux;
    } else {
        return OSType.Unknown;
    }
}

function untildifyImpl(path: string, home: string) {
    return path.replace(/^~(?=$|\/|\\)/, home);
}

// Export through a mutable object to allow stubbing in ESM tests
export const platformUtils = {
    getOSType: getOSTypeImpl,
    untildify: untildifyImpl
};

// Delegation wrappers that call through platformUtils at runtime
// This allows test stubs to take effect
export const getOSType = (platform: string = process.platform): OSType => platformUtils.getOSType(platform);
export const untildify = (path: string, home: string): string => platformUtils.untildify(path, home);

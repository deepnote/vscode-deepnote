// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as stackTrace from 'stack-trace';
import { getTelemetrySafeHashedString } from '../telemetry/helpers';
import { getErrorTags } from './errors';
import { getLastFrameFromPythonTraceback } from './errorUtils';
import { getErrorCategory, TelemetryErrorProperties, BaseError } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function populateTelemetryWithErrorInfo(props: Partial<TelemetryErrorProperties>, error: Error) {
    props.failed = true;
    // Don't blow away what we already have.
    props.failureCategory = props.failureCategory || getErrorCategory(error);

    // Detect fetch errors by shape instead of using instanceof
    // - Native FetchError (node-fetch or some runtimes): error.name === 'FetchError'
    // - Browser fetch failures: error.name === 'TypeError' && message matches 'failed to fetch'
    // - Global FetchError support: check if globalThis has FetchError
    const globalFetchError = (globalThis as typeof globalThis & { FetchError?: ErrorConstructor }).FetchError;
    const isFetchError =
        error?.name === 'FetchError' ||
        (error?.name === 'TypeError' && /failed to fetch/i.test(String(error.message))) ||
        (typeof globalFetchError !== 'undefined' && error instanceof globalFetchError);

    if (props.failureCategory === 'unknown' && isFetchError) {
        props.failureCategory = 'fetcherror';
    }

    props.stackTrace = serializeStackTrace(error);
    if (typeof error === 'string') {
        // Helps us determine that we are rejecting with errors in some places, in which case we aren't getting meaningful errors/data.
        props.failureSubCategory = 'errorisstring';
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stdErr = (error as BaseError).stdErr ? (error as BaseError).stdErr : error.stack || '';
    if (!stdErr) {
        return;
    }
    props.failureSubCategory = props.failureSubCategory || getErrorTags(stdErr);
    const info = getLastFrameFromPythonTraceback(stdErr);
    if (!info) {
        return;
    }
    [props.pythonErrorFile, props.pythonErrorFolder, props.pythonErrorPackage] = await Promise.all([
        Promise.resolve(props.pythonErrorFile || getTelemetrySafeHashedString(info.fileName)),
        Promise.resolve(props.pythonErrorFolder || getTelemetrySafeHashedString(info.folderName)),
        Promise.resolve(props.pythonErrorPackage || getTelemetrySafeHashedString(info.packageName))
    ]);
}

export function parseStack(ex: Error) {
    // Work around bug in stackTrace when ex has an array already
    if (ex.stack && Array.isArray(ex.stack)) {
        const concatenated = { ...ex, stack: ex.stack.join('\n') };
        // Work around for https://github.com/microsoft/vscode-jupyter/issues/12550
        return stackTrace.parse.call(stackTrace, concatenated);
    }
    // Work around for https://github.com/microsoft/vscode-jupyter/issues/12550
    return stackTrace.parse.call(stackTrace, ex);
}

function serializeStackTrace(ex: Error): string {
    // We aren't showing the error message (ex.message) since it might contain PII.
    let trace = '';
    for (const frame of parseStack(ex)) {
        const filename = frame.getFileName();
        if (filename) {
            const lineno = frame.getLineNumber();
            const colno = frame.getColumnNumber();
            trace += `\n\tat ${getCallSite(frame)} ${filename}:${lineno}:${colno}`;
        } else {
            trace += '\n\tat <anonymous>';
        }
    }
    // Ensure we always use `/` as path separators.
    // This way stack traces (with relative paths) coming from different OS will always look the same.
    return trace.trim().replace(/\\/g, '/');
}

function getCallSite(frame: stackTrace.StackFrame) {
    const parts: string[] = [];
    if (typeof frame.getTypeName() === 'string' && frame.getTypeName().length > 0) {
        parts.push(frame.getTypeName());
    }
    if (typeof frame.getMethodName() === 'string' && frame.getMethodName().length > 0) {
        parts.push(frame.getMethodName());
    }
    if (typeof frame.getFunctionName() === 'string' && frame.getFunctionName().length > 0) {
        if (parts.length !== 2 || parts.join('.') !== frame.getFunctionName()) {
            parts.push(frame.getFunctionName());
        }
    }
    return parts.join('.');
}

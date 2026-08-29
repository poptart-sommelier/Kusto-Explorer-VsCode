// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as crypto from 'crypto';

export function createClientRequestId(): string {
    return `KustoExplorerVsCode;${crypto.randomUUID()}`;
}

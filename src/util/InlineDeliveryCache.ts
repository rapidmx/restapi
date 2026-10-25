///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * What the zero-access recipients of one delivery share while `ScanQueueJob.processInline()` processes each (`BaseMailIngestRoute`
 * builds one per request): the scan of the same message for the same envelope (every member of a distribution list), and the text
 * extracted from its attachments - so the extraction budget is spent once per message, not once per recipient. Keyed by the raw message
 * itself, by identity.
 */
export class InlineDeliveryCache {
    private readonly ids: Map<Buffer, number> = new Map();
    private readonly values: Map<string, Promise<unknown>> = new Map();

    /** `make()`'s result for `raw` and `key`, made once per cache. */
    public once<T>(raw: Buffer, key: string, make: () => Promise<T>): Promise<T> {
        if (!this.ids.has(raw)) {
            this.ids.set(raw, this.ids.size);
        }
        const id: string = `${this.ids.get(raw)}:${key}`;
        if (!this.values.has(id)) {
            this.values.set(id, make());
        }
        return this.values.get(id) as Promise<T>;
    }
}

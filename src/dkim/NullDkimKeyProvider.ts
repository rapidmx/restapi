///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DkimKeyPair, DkimKeyProvider } from "./DkimKeyProvider.js";

/**
 * The default `DkimKeyProvider` - never generates or stores DKIM key material, preserving this library's
 * original manual model (an admin runs their own OpenDKIM keygen and fills in `Domain.dkimSelector`/
 * `dkimPublicKey` by hand). `@Inject("DkimKeyProvider")` has no notion of an optional/unregistered
 * dependency (unlike a plain `?:` field, the framework throws at construction time if nothing is
 * registered under the token at all), so *some* class must always be registered here - a consuming
 * application registers this one to keep the manual model, or `FsDkimKeyProvider` (or its own custom
 * implementation) to opt into automatic key generation. See `DkimKeyProvider`'s own doc comment.
 *
 * @author Jean-Philippe Steinmetz
 */
export class NullDkimKeyProvider implements DkimKeyProvider {
    public async ensureKeyPair(_domain: string): Promise<DkimKeyPair | undefined> {
        return undefined;
    }
}

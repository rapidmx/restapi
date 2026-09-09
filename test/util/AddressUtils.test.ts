///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { stripPlusTag } from "../../src/util/AddressUtils.js";

describe("stripPlusTag() Tests", () => {
    it("Strips a plus-tag from the local part.", () => {
        expect(stripPlusTag("user+tag@domain.com")).toBe("user@domain.com");
    });

    it("Strips only up to the first plus - a second plus is part of the stripped tag.", () => {
        expect(stripPlusTag("user+tag+more@domain.com")).toBe("user@domain.com");
    });

    it("Returns the address unchanged when the local part has no plus.", () => {
        expect(stripPlusTag("user@domain.com")).toBe("user@domain.com");
    });

    it("Returns the address unchanged when it has no @ at all.", () => {
        expect(stripPlusTag("not-an-address")).toBe("not-an-address");
    });

    it("Never touches the domain, even if it contains a plus.", () => {
        expect(stripPlusTag("user+tag@sub+domain.com")).toBe("user@sub+domain.com");
    });
});

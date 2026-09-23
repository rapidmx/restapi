///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import {
    assertNoPathKeys,
    assertPlainPropertyName,
    isDuplicateKeyError,
    isPathKey,
    stripClientCreateFields,
    stripClientId,
} from "../../src/util/RequestBodyUtils.js";

describe("RequestBodyUtils", () => {
    it("isPathKey() flags dotted, $, and prototype-pollution-shaped keys", () => {
        expect(isPathKey("aliasAddresses.0")).toBe(true);
        expect(isPathKey("$set")).toBe(true);
        expect(isPathKey("__proto__")).toBe(true);
        expect(isPathKey("constructor")).toBe(true);
        expect(isPathKey("prototype")).toBe(true);
        expect(isPathKey("aliasAddresses")).toBe(false);
        expect(isPathKey("a$b")).toBe(false);
    });

    it("assertNoPathKeys() refuses a JSON-parsed body carrying an own __proto__/constructor/prototype key", () => {
        // A plain object LITERAL `{ __proto__: {...} }` sets the actual prototype rather than creating an own
        // enumerable property - `JSON.parse()` (what a real HTTP body goes through) does not special-case it,
        // so this is the shape an actual malicious request body takes.
        expect(() => assertNoPathKeys(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(/not a valid field name/);
        expect(() => assertNoPathKeys(JSON.parse('{"constructor":{"polluted":true}}'))).toThrow(/not a valid field name/);
        expect(() => assertNoPathKeys(JSON.parse('{"prototype":{"polluted":true}}'))).toThrow(/not a valid field name/);
    });

    it("assertNoPathKeys() refuses a path key at the top level of an object or of any array element", () => {
        expect(() => assertNoPathKeys({ "keys.0": {} })).toThrow(/not a valid field name/);
        expect(() => assertNoPathKeys({ $inc: { x: 1 } })).toThrow(/not a valid field name/);
        expect(() => assertNoPathKeys([{ ok: 1 }, { "flags.read": true }])).toThrow(/not a valid field name/);
        expect(() => assertNoPathKeys({ ok: 1, nested: { "a.b": 1 } })).not.toThrow();
        expect(() => assertNoPathKeys(undefined)).not.toThrow();
        expect(() => assertNoPathKeys("text")).not.toThrow();
        expect(() => assertNoPathKeys([{ ok: 1 }, 5])).not.toThrow();
    });

    it("assertPlainPropertyName() refuses empty, non-string, dotted and $ names", () => {
        for (const name of ["", "a.b", "$set", undefined, 5]) {
            expect(() => assertPlainPropertyName(name)).toThrow(/not a valid field name/);
        }
        expect(() => assertPlainPropertyName("aliasAddresses")).not.toThrow();
    });

    it("stripClientCreateFields() drops entity-managed and path keys in place, for objects and arrays", () => {
        const single: any = { _id: "x", version: 3, dateCreated: "d", dateModified: "d", "a.b": 1, $set: {}, name: "kept" };
        expect(stripClientCreateFields(single)).toBe(single);
        expect(single).toEqual({ name: "kept" });

        const polluted: any = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"prototype":1,"name":"kept"}');
        stripClientCreateFields(polluted);
        expect(polluted).toEqual({ name: "kept" });
        expect(({} as any).polluted).toBeUndefined();

        const many: any[] = [{ _id: "x", name: "a" }, { version: 1, name: "b" }, 7];
        stripClientCreateFields(many);
        expect(many).toEqual([{ name: "a" }, { name: "b" }, 7]);
        expect(stripClientCreateFields(null)).toBeNull();
    });

    it("stripClientId() drops _id from an object body only", () => {
        const obj: any = { _id: "x", name: "kept" };
        stripClientId(obj);
        expect(obj).toEqual({ name: "kept" });
        const arr: any = [{ _id: "x" }];
        stripClientId(arr);
        expect(arr).toEqual([{ _id: "x" }]);
        expect(() => stripClientId(undefined)).not.toThrow();
    });

    it("isDuplicateKeyError() recognizes Mongo and SQL unique-index violations", () => {
        expect(isDuplicateKeyError(undefined)).toBe(false);
        expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
        expect(isDuplicateKeyError({ code: "23505" })).toBe(true);
        expect(isDuplicateKeyError({ code: "ER_DUP_ENTRY" })).toBe(true);
        expect(isDuplicateKeyError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
        expect(isDuplicateKeyError(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: t.a"))).toBe(true);
        expect(isDuplicateKeyError(new Error("E11000 duplicate key error collection"))).toBe(true);
        expect(isDuplicateKeyError({})).toBe(false);
        // service-core 2.1.0 maps a duplicate key on create to a 400 IDENTIFIER_EXISTS; restapi's own 409s aren't one.
        expect(isDuplicateKeyError(new ApiError(ApiErrors.IDENTIFIER_EXISTS, 400, "exists"))).toBe(true);
        expect(isDuplicateKeyError(new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "in use"))).toBe(false);
        expect(isDuplicateKeyError(new Error("something else"))).toBe(false);
    });
});

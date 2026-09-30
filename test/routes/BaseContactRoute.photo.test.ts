///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    CONTACT_PHOTO_CONTENT_TYPES,
    CONTACT_PHOTO_KEY_PREFIX,
    CONTACT_PHOTO_MAX_BYTES,
    sniffContactPhotoType,
} from "../../src/routes/BaseContactRoute.js";

describe("BaseContactRoute contact photo helpers", () => {
    it("Limits a photo to 1 MiB of JPEG, PNG, GIF or WebP, stored under contact-photos/.", () => {
        expect(CONTACT_PHOTO_MAX_BYTES).toBe(1024 * 1024);
        expect([...CONTACT_PHOTO_CONTENT_TYPES]).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp"]);
        expect(CONTACT_PHOTO_KEY_PREFIX).toBe("contact-photos/");
    });

    it("Recognizes each allowed type by its magic bytes.", () => {
        expect(sniffContactPhotoType(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0]))).toBe("image/jpeg");
        expect(sniffContactPhotoType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
        expect(sniffContactPhotoType(Buffer.from("GIF87a...."))).toBe("image/gif");
        expect(sniffContactPhotoType(Buffer.from("GIF89a...."))).toBe("image/gif");
        expect(sniffContactPhotoType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe("image/webp");
    });

    it("Recognizes nothing else: not SVG, AVIF, a truncated GIF signature or arbitrary bytes.", () => {
        expect(sniffContactPhotoType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
        expect(sniffContactPhotoType(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypavif"), Buffer.alloc(16)]))).toBeUndefined();
        expect(sniffContactPhotoType(Buffer.from("GIF8"))).toBeUndefined();
        expect(sniffContactPhotoType(Buffer.from("GIF90a...."))).toBeUndefined();
        expect(sniffContactPhotoType(Buffer.alloc(0))).toBeUndefined();
    });
});

///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { escapeLike, LIKE_ESCAPE, rawLike } from "../../../src/routes/sql/LikeUtils.js";
import { escapeDirectoryLike } from "../../../src/routes/BaseDirectoryRoute.js";

describe("SQL LIKE helpers", () => {
    it("escape % and _ with an escape character that is not a backslash", () => {
        expect(LIKE_ESCAPE).toBe("!");
        expect(escapeLike("50%_!x\\")).toBe("50!%!_!!x\\");
        expect(escapeDirectoryLike("50%_!x\\")).toBe("50!%!_!!x\\");
    });

    it("declare ESCAPE '!', never the backslash literal MySQL and MariaDB read as unterminated", () => {
        const operator: any = rawLike("%x%");
        const sql: string = operator.getSql("alias");
        expect(sql).toBe("alias LIKE :pattern ESCAPE '!'");
        expect(sql).not.toContain("\\");
        expect(operator.objectLiteralParameters).toEqual({ pattern: "%x%" });
    });
});

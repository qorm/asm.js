import * as os from "os";
import * as path from "path";

export function defaultBuildSocket(env = process.env) {
    return env.ASMJS_BUILD_SOCKET ||
        path.join(env.XDG_RUNTIME_DIR || os.tmpdir(),
            `asmjs-build-${process.getuid ? process.getuid() : "user"}.sock`);
}

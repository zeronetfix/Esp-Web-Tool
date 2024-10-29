// @ts-ignore-next-line
import { Transport } from "esptool-js/webserial.js";
// @ts-ignore-next-line
import { ESPLoader } from "esptool-js/ESPLoader.js";
import { sleep } from "./util/sleep";
const resetTransport = async (transport) => {
    await transport.device.setSignals({
        dataTerminalReady: false,
        requestToSend: true,
    });
    await transport.device.setSignals({
        dataTerminalReady: false,
        requestToSend: false,
    });
};
export const flash = async (onEvent, port, manifestPath, manifest, eraseFirst) => {
    let build;
    let chipFamily;
    const fireStateEvent = (stateUpdate) => onEvent({
        ...stateUpdate,
        manifest,
        build,
        chipFamily,
    });
    const transport = new Transport(port);
    const esploader = new ESPLoader(transport, 115200);
    // For debugging
    window.esploader = esploader;
    fireStateEvent({
        state: "initializing" /* FlashStateType.INITIALIZING */,
        message: "Initializing...",
        details: { done: false },
    });
    try {
        await esploader.main_fn();
        await esploader.flash_id();
    }
    catch (err) {
        console.error(err);
        fireStateEvent({
            state: "error" /* FlashStateType.ERROR */,
            message: "Failed to initialize. Try resetting your device or holding the BOOT button while clicking INSTALL.",
            details: { error: "failed_initialize" /* FlashError.FAILED_INITIALIZING */, details: err },
        });
        await resetTransport(transport);
        await transport.disconnect();
        return;
    }
    chipFamily = await esploader.chip.CHIP_NAME;
    if (!esploader.chip.ROM_TEXT) {
        fireStateEvent({
            state: "error" /* FlashStateType.ERROR */,
            message: `Chip ${chipFamily} is not supported`,
            details: {
                error: "not_supported" /* FlashError.NOT_SUPPORTED */,
                details: `Chip ${chipFamily} is not supported`,
            },
        });
        await resetTransport(transport);
        await transport.disconnect();
        return;
    }
    fireStateEvent({
        state: "initializing" /* FlashStateType.INITIALIZING */,
        message: `Initialized. Found ${chipFamily}`,
        details: { done: true },
    });
    build = manifest.builds.find((b) => b.chipFamily === chipFamily);
    if (!build) {
        fireStateEvent({
            state: "error" /* FlashStateType.ERROR */,
            message: `Your ${chipFamily} board is not supported.`,
            details: { error: "not_supported" /* FlashError.NOT_SUPPORTED */, details: chipFamily },
        });
        await resetTransport(transport);
        await transport.disconnect();
        return;
    }
    fireStateEvent({
        state: "preparing" /* FlashStateType.PREPARING */,
        message: "Preparing installation...",
        details: { done: false },
    });
    const manifestURL = new URL(manifestPath, location.toString()).toString();
    const filePromises = build.parts.map(async (part) => {
        const url = new URL(part.path, manifestURL).toString();
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Downlading firmware ${part.path} failed: ${resp.status}`);
        }
        const reader = new FileReader();
        const blob = await resp.blob();
        return new Promise((resolve) => {
            reader.addEventListener("load", () => resolve(reader.result));
            reader.readAsBinaryString(blob);
        });
    });
    const fileArray = [];
    let totalSize = 0;
    for (let part = 0; part < filePromises.length; part++) {
        try {
            const data = await filePromises[part];
            fileArray.push({ data, address: build.parts[part].offset });
            totalSize += data.length;
        }
        catch (err) {
            fireStateEvent({
                state: "error" /* FlashStateType.ERROR */,
                message: err.message,
                details: {
                    error: "failed_firmware_download" /* FlashError.FAILED_FIRMWARE_DOWNLOAD */,
                    details: err.message,
                },
            });
            await resetTransport(transport);
            await transport.disconnect();
            return;
        }
    }
    fireStateEvent({
        state: "preparing" /* FlashStateType.PREPARING */,
        message: "Installation prepared",
        details: { done: true },
    });
    if (eraseFirst) {
        fireStateEvent({
            state: "erasing" /* FlashStateType.ERASING */,
            message: "Erasing device...",
            details: { done: false },
        });
        await esploader.erase_flash();
        fireStateEvent({
            state: "erasing" /* FlashStateType.ERASING */,
            message: "Device erased",
            details: { done: true },
        });
    }
    fireStateEvent({
        state: "writing" /* FlashStateType.WRITING */,
        message: `Writing progress: 0%`,
        details: {
            bytesTotal: totalSize,
            bytesWritten: 0,
            percentage: 0,
        },
    });
    let totalWritten = 0;
    try {
        await esploader.write_flash({
            fileArray,
            reportProgress(fileIndex, written, total) {
                const uncompressedWritten = (written / total) * fileArray[fileIndex].data.length;
                const newPct = Math.floor(((totalWritten + uncompressedWritten) / totalSize) * 100);
                // we're done with this file
                if (written === total) {
                    totalWritten += uncompressedWritten;
                    return;
                }
                fireStateEvent({
                    state: "writing" /* FlashStateType.WRITING */,
                    message: `Writing progress: ${newPct}%`,
                    details: {
                        bytesTotal: totalSize,
                        bytesWritten: totalWritten + written,
                        percentage: newPct,
                    },
                });
            },
        });
    }
    catch (err) {
        fireStateEvent({
            state: "error" /* FlashStateType.ERROR */,
            message: err.message,
            details: { error: "write_failed" /* FlashError.WRITE_FAILED */, details: err },
        });
        await resetTransport(transport);
        await transport.disconnect();
        return;
    }
    fireStateEvent({
        state: "writing" /* FlashStateType.WRITING */,
        message: "Writing complete",
        details: {
            bytesTotal: totalSize,
            bytesWritten: totalWritten,
            percentage: 100,
        },
    });
    await sleep(100);
    console.log("HARD RESET");
    await resetTransport(transport);
    console.log("DISCONNECT");
    await transport.disconnect();
    fireStateEvent({
        state: "finished" /* FlashStateType.FINISHED */,
        message: "All done!",
    });
};

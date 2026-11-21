#!/usr/bin/env node
// Talk to a zigbee-rs NCP over ZRHP without Zigbee2MQTT: handshake, then print what the NCP reports.
//
//   node scripts/zrhp-probe.js /dev/ttyACM0 [baudrate] [--rtscts]   (Windows: COMn; from faronov/zigbee-herdsman scripts/zrhp/probe.js)
//
// Exit code 0 when a ZRHP session was established. Read-only: it changes nothing on the NCP.

const path = require("node:path");

function load(mod) {
    for (const base of [process.cwd(), path.join(__dirname, ".."), path.join(__dirname, "../..")]) {
        try {
            return require(require.resolve(mod, {paths: [base]}));
        } catch {}
    }
    // inside a zigbee-herdsman checkout (after `pnpm run build`)
    try {
        return require(path.join(__dirname, "../..", mod.replace(/^zigbee-herdsman\//, "")));
    } catch {}
    throw new Error(`cannot find ${mod}: run this from the Zigbee2MQTT checkout built by scripts/zrhp/build-z2m.sh`);
}

async function main() {
    const args = process.argv.slice(2);
    const port = args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a));
    const baudRate = Number(args.find((a) => /^\d+$/.test(a)) ?? 921600);
    const rtscts = args.includes("--rtscts");

    if (!port) {
        console.error("usage: node probe.js <serial port> [baudrate] [--rtscts]");
        process.exit(2);
    }

    const {AdapterTransport} = load("zigbee-herdsman/dist/adapter/transport");
    const {ZrhpApi} = load("zigbee-herdsman/dist/adapter/zrhp/api");
    const M = load("zigbee-herdsman/dist/adapter/zrhp/messages");
    const transport = new AdapterTransport({path: port, baudRate, rtscts});
    const api = new ZrhpApi({name: "zrhp-probe", handshakeTimeout: 5000});
    transport.on("data", (d) => api.receive(d));
    await transport.open(true);
    const stream = {write: (d) => transport.isOpen && transport.write(d)};

    try {
        const session = await api.connect(stream);
        const n = session.negotiate;
        console.log(
            `ZRHP session OK: protocol ${n.major}.${n.minor}, firmware ${session.fwVersion}, chip ${n.chip}, build ${n.buildId.toString("hex")}`,
        );
        console.log(
            `  NCP cookie 0x${session.ncpCookie.toString(16)}, reset reason ${session.ready.resetReason}, network state ${session.ready.networkState} (0 none, 1 formed, 2 up)`,
        );
        console.log(`  capabilities 0x${n.ncpCaps.toString(16)}`);
        const [, info] = await api.request(M.Id.SYS_GET_INFO, M.SysGetInfoReq, {}, M.SysGetInfoRsp);
        const be = (b) => Buffer.from(b).reverse().toString("hex");
        console.log(
            `  product "${info.product}", board "${info.board}", IEEE 0x${be(info.ieeeActive)}, transport ${info.transport === 1 ? "USB-Serial-JTAG" : `UART ${info.uartBaud} baud, flow ${info.uartFlow ? "RTS/CTS" : "none"}`}, flash ${info.flashSize >> 20} MB`,
        );
        const [, nwk] = await api.request(M.Id.NWK_GET_INFO, M.NwkGetInfoReq, {}, M.NwkGetInfoRsp);

        if (nwk.state === 2) {
            console.log(`  network: PAN 0x${nwk.panId.toString(16)}, EPID 0x${be(nwk.extPanId)}, channel ${nwk.channel}`);
        }

        const [, c] = await api.request(M.Id.DIAG_GET_COUNTERS, M.DiagGetCountersReq, {groupMask: 0x01}, M.DiagGetCountersRsp);
        const counters = Object.fromEntries(c.counters.map((x) => [`0x${x.id.toString(16)}`, x.value]));
        console.log(`  NCP link counters: ${JSON.stringify(counters)}`);
    } catch (error) {
        console.error(`No ZRHP session on ${port}: ${error.message}`);
        console.error("Check the port (the DevKit's USB port, not UART), that the NCP image is flashed, and that nothing else has the port open.");
        process.exitCode = 1;
    } finally {
        api.disconnect();
        await transport.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

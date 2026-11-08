import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendEmail, transportOptions } from "./email";

describe("transportOptions", () => {
  it("uses TLS from the start for smtps", () => {
    expect(
      transportOptions("smtps://alerts:secret@mail.example.com"),
    ).toMatchObject({
      host: "mail.example.com",
      secure: true,
      requireTLS: false,
      auth: { user: "alerts", pass: "secret" },
    });
  });

  it("requires STARTTLS for smtp with a password", () => {
    expect(
      transportOptions("smtp://alerts:secret@mail.example.com:587"),
    ).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it("allows an unauthenticated relay without TLS", () => {
    const options = transportOptions("smtp://relay.internal:25");
    expect(options).toMatchObject({ port: 25, requireTLS: false });
    expect(options.auth).toBeUndefined();
  });

  it("decodes the username and password", () => {
    expect(
      transportOptions("smtp://a%40b.example:p%2Fw%3A1@mail.example.com").auth,
    ).toEqual({ user: "a@b.example", pass: "p/w:1" });
  });

  it.each(["https://mail.example.com", "smtp:", "not a url"])(
    "refuses %s",
    (url) => {
      expect(() => transportOptions(url)).toThrow();
    },
  );
});

describe("sendEmail", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  });

  /** A minimal SMTP server, refusing recipients with "refused" in them. */
  async function smtpServer() {
    const received: string[] = [];
    server = createServer((socket) => {
      let inData = false;
      let buffer = "";
      socket.write("220 test\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          received.push(line);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 queued\r\n");
            }
          } else if (/^EHLO/i.test(line)) {
            socket.write("250-test\r\n250 8BITMIME\r\n");
          } else if (/^RCPT/i.test(line) && line.includes("refused")) {
            socket.write("550 no such user\r\n");
          } else if (/^STARTTLS/i.test(line)) {
            socket.write("502 not supported\r\n");
          } else if (/^DATA/i.test(line)) {
            inData = true;
            socket.write("354 go ahead\r\n");
          } else if (/^QUIT/i.test(line)) {
            socket.end("221 bye\r\n");
          } else {
            socket.write("250 ok\r\n");
          }
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    return { received, port: (server!.address() as AddressInfo).port };
  }

  const content = { subject: "Support Bot: over budget", text: "Over.\n" };

  it("delivers the message over SMTP", async () => {
    const { received, port } = await smtpServer();
    const result = await sendEmail(
      {
        smtpUrl: `smtp://127.0.0.1:${port}`,
        from: "alerts@example.com",
        to: ["a@example.com", "b@example.com"],
      },
      content,
    );
    expect(result).toEqual({ rejected: [] });
    expect(received.join("\n")).toMatch(/MAIL FROM:<alerts@example\.com>/);
    expect(received.join("\n")).toMatch(/RCPT TO:<a@example\.com>/);
    expect(received.join("\n")).toMatch(/RCPT TO:<b@example\.com>/);
    expect(received).toContain("Subject: Support Bot: over budget");
    expect(received).toContain("Over.");
  });

  it("reports recipients refused while others were accepted", async () => {
    const { port } = await smtpServer();
    await expect(
      sendEmail(
        {
          smtpUrl: `smtp://127.0.0.1:${port}`,
          from: "alerts@example.com",
          to: ["a@example.com", "refused@example.com"],
        },
        content,
      ),
    ).resolves.toEqual({ rejected: ["refused@example.com"] });
  });

  it("won't send a password to a server without STARTTLS", async () => {
    const { received, port } = await smtpServer();
    await expect(
      sendEmail(
        {
          smtpUrl: `smtp://alerts:hunter2@127.0.0.1:${port}`,
          from: "alerts@example.com",
          to: ["a@example.com"],
        },
        content,
      ),
    ).rejects.toThrow();
    expect(received.some((line) => /^AUTH/i.test(line))).toBe(false);
    expect(received.some((line) => /^MAIL/i.test(line))).toBe(false);
  });
});

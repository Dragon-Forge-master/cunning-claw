import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedDeskDevice,
  defaultDeskDevice,
  deskCaptureArgs,
  lookCaption,
  parseCameraEntity,
  sniffMediaType,
} from "./eyes.js";

test("Linux webcam is /dev/videoN only — no arbitrary paths", () => {
  assert.equal(allowedDeskDevice("/dev/video0", "linux"), true);
  assert.equal(allowedDeskDevice("/dev/video12", "linux"), true);
  assert.equal(allowedDeskDevice("/dev/sda1", "linux"), false);
  assert.equal(allowedDeskDevice("/etc/passwd", "linux"), false);
  assert.equal(allowedDeskDevice("video0", "linux"), false);
  assert.equal(allowedDeskDevice("/dev/video0;reboot", "linux"), false);
});

test("Darwin webcam is an index or a short device name", () => {
  assert.equal(allowedDeskDevice("0", "darwin"), true);
  assert.equal(allowedDeskDevice("FaceTime HD Camera", "darwin"), true);
  assert.equal(allowedDeskDevice("../../etc/passwd", "darwin"), false);
  assert.equal(allowedDeskDevice("0;reboot", "darwin"), false);
});

test("default desk device matches the OS", () => {
  assert.equal(defaultDeskDevice("linux"), "/dev/video0");
  assert.equal(defaultDeskDevice("darwin"), "0");
  assert.equal(defaultDeskDevice("win32"), "");
});

test("ffmpeg args never take a path the model invented", () => {
  const linux = deskCaptureArgs("/dev/video0", "/tmp/desk.jpg", "linux");
  assert.ok(Array.isArray(linux));
  if (Array.isArray(linux)) {
    assert.ok(linux.includes("v4l2"));
    assert.ok(linux.includes("/dev/video0"));
    assert.ok(linux.includes("/tmp/desk.jpg"));
  }
  const refused = deskCaptureArgs("/etc/passwd", "/tmp/x.jpg", "linux");
  assert.ok(!Array.isArray(refused) && "error" in refused);

  const darwin = deskCaptureArgs("0", "/tmp/desk.jpg", "darwin");
  assert.ok(Array.isArray(darwin));
  if (Array.isArray(darwin)) assert.ok(darwin.includes("avfoundation"));
});

test("house cameras are camera.entity ids, never URLs", () => {
  assert.equal(parseCameraEntity("camera.front_door"), "camera.front_door");
  assert.equal(parseCameraEntity("CAMERA.Yard_1"), "camera.yard_1");
  assert.equal(parseCameraEntity("light.kitchen"), null);
  assert.equal(parseCameraEntity("http://homeassistant.local/api/camera_proxy/x"), null);
  assert.equal(parseCameraEntity("camera.front/../secrets"), null);
  assert.equal(parseCameraEntity("camera.front_door?raw"), null);
});

test("sniffMediaType reads JPEG and PNG magic, not guesses", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const empty = Buffer.from([0x00, 0x01, 0x02]);
  assert.equal(sniffMediaType(jpeg), "image/jpeg");
  assert.equal(sniffMediaType(png), "image/png");
  assert.equal(sniffMediaType(empty), null);
});

test("look caption names the law: mood is a hypothesis", () => {
  const desk = lookCaption("desk", 84);
  assert.match(desk, /desk webcam/);
  assert.match(desk, /84KB/);
  assert.match(desk, /hypothesis/);
  const house = lookCaption("house", 12, " camera.porch.");
  assert.match(house, /house camera/);
  assert.match(house, /camera.porch/);
});

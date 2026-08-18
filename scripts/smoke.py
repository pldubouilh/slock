#!/usr/bin/env python3
"""End-to-end smoke test for slock.

Boots nothing itself: point it at an already-running server whose database is
empty apart from the bootstrap admin.

    DATABASE_URL=... go run ./cmd/slock &
    python3 scripts/smoke.py http://127.0.0.1:8099 admin@localhost hunter2hunter2

Exits non-zero on the first failure, with the request and response that broke.
"""

import http.cookiejar
import io
import json
import mimetypes
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099"
ADMIN_EMAIL = sys.argv[2] if len(sys.argv) > 2 else "admin@localhost"
ADMIN_PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "smoke-admin-pw-1"

PASSED = []
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


class Client:
    """One browser: its own cookie jar."""

    def __init__(self, label):
        self.label = label
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=CTX),
        )

    def call(self, method, path, body=None, expect=None, raw=None, headers=None):
        url = BASE + path
        data, hdrs = None, {"Accept": "application/json"}
        if raw is not None:
            data, ctype = raw
            hdrs["Content-Type"] = ctype
        elif body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        hdrs.update(headers or {})

        req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
        try:
            with self.opener.open(req, timeout=20) as resp:
                status, payload, rheaders = resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            status, payload, rheaders = e.code, e.read(), dict(e.headers)

        parsed = None
        if payload[:1] in (b"{", b"["):
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                parsed = None

        if expect is not None and status != expect:
            fail(
                f"{self.label} {method} {path} -> {status}, expected {expect}\n"
                f"  response: {payload[:600]!r}"
            )
        return status, (parsed if parsed is not None else payload), rheaders

    def json(self, method, path, body=None, expect=200):
        _, payload, _ = self.call(method, path, body, expect=expect)
        if not isinstance(payload, (dict, list)):
            fail(f"{self.label} {method} {path}: expected JSON, got {payload[:200]!r}")
        return payload

    def upload(self, path, filename, content, ctype=None, expect=201):
        ctype = ctype or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        boundary = "----slock" + uuid.uuid4().hex
        buf = io.BytesIO()
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
        )
        buf.write(f"Content-Type: {ctype}\r\n\r\n".encode())
        buf.write(content)
        buf.write(f"\r\n--{boundary}--\r\n".encode())
        _, payload, _ = self.call(
            "POST", path, raw=(buf.getvalue(), f"multipart/form-data; boundary={boundary}"),
            expect=expect,
        )
        return payload


def jpeg_size(blob):
    """Width/height from a JPEG's SOF marker, so the test needs no image library."""
    if blob[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 9 < len(blob):
        if blob[i] != 0xFF:
            i += 1
            continue
        marker = blob[i + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seglen = int.from_bytes(blob[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height = int.from_bytes(blob[i + 5:i + 7], "big")
            width = int.from_bytes(blob[i + 7:i + 9], "big")
            return width, height
        i += 2 + seglen
    return None


def fail(msg):
    print("\n\033[31mFAIL\033[0m " + msg, file=sys.stderr)
    print(f"\n{len(PASSED)} checks passed before the failure.", file=sys.stderr)
    sys.exit(1)


def check(cond, msg):
    if not cond:
        fail(msg)
    PASSED.append(msg)


def section(name):
    print(f"\n\033[1m{name}\033[0m")


def ok(msg):
    PASSED.append(msg)
    print(f"  \033[32m✓\033[0m {msg}")


class SSE(threading.Thread):
    """Reads an event stream in the background and records the frames."""

    def __init__(self, client):
        super().__init__(daemon=True)
        self.client = client
        self.events = []
        self.ready = threading.Event()
        self.stop = threading.Event()
        self.error = None

    def run(self):
        req = urllib.request.Request(
            BASE + "/api/events", headers={"Accept": "text/event-stream"}
        )
        try:
            resp = self.client.opener.open(req, timeout=30)
            name, data = None, []
            for rawline in resp:
                if self.stop.is_set():
                    break
                line = rawline.decode("utf-8", "replace").rstrip("\r\n")
                if line.startswith(":"):
                    continue
                if line == "":
                    if name:
                        try:
                            self.events.append((name, json.loads("\n".join(data) or "{}")))
                        except json.JSONDecodeError:
                            self.events.append((name, None))
                        if name == "hello":
                            self.ready.set()
                    name, data = None, []
                    continue
                if line.startswith("event:"):
                    name = line[6:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].strip())
        except Exception as e:  # noqa: BLE001 - surfaced by the assertions below
            self.error = e
            self.ready.set()

    def wait_for(self, kind, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for name, payload in list(self.events):
                if name == kind:
                    return payload
            time.sleep(0.05)
        return None


def main():
    admin = Client("admin")

    # ---------------------------------------------------------------- auth
    section("auth")
    admin.call("GET", "/api/channels", expect=401)
    ok("unauthenticated requests are rejected")

    admin.call("POST", "/api/auth/login",
               {"email": ADMIN_EMAIL, "password": "totally-wrong"}, expect=401)
    ok("bad password is rejected")

    me = admin.json("POST", "/api/auth/login",
                    {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    check(me["user"]["is_admin"], "bootstrap user is an admin")
    admin_id = me["user"]["id"]
    ok("admin can sign in")

    me = admin.json("GET", "/api/auth/me")
    check(me["user"]["id"] == admin_id, "/me returns the signed-in user")
    check("push_public_key" in me, "/me exposes push_public_key")
    ok("/api/auth/me works")

    # ------------------------------------------------------------- users
    section("admin: creating users")
    ana = admin.json("POST", "/api/admin/users",
                     {"email": "ana@example.com", "display_name": "Ana"}, expect=201)
    check(len(ana["temp_password"]) >= 12, "a temporary password is returned")
    check(ana["user"]["must_change_pw"], "new users must change their password")
    ana_id = ana["user"]["id"]
    ok("admin created Ana")

    bo = admin.json("POST", "/api/admin/users",
                    {"email": "bo@example.com", "display_name": "Bo"}, expect=201)
    bo_id = bo["user"]["id"]
    ok("admin created Bo")

    admin.call("POST", "/api/admin/users",
               {"email": "ana@example.com", "display_name": "Dup"}, expect=409)
    ok("duplicate email is a conflict")

    admin.call("PATCH", f"/api/admin/users/{admin_id}", {"is_admin": False}, expect=409)
    ok("an admin cannot demote themselves")

    # Ana signs in and is forced to change her password.
    ana_c = Client("ana")
    login = ana_c.json("POST", "/api/auth/login",
                       {"email": "ana@example.com", "password": ana["temp_password"]})
    check(login["must_change_pw"], "Ana is flagged must_change_pw")
    ana_c.call("POST", "/api/auth/password",
               {"current_password": ana["temp_password"], "new_password": "short"}, expect=400)
    ok("short passwords are rejected")
    ana_c.call("POST", "/api/auth/password",
               {"current_password": ana["temp_password"], "new_password": "ana-secret-9x"},
               expect=204)
    check(not ana_c.json("GET", "/api/auth/me")["must_change_pw"],
          "must_change_pw clears after the change")
    ok("Ana changed her password")

    bo_c = Client("bo")
    bo_c.json("POST", "/api/auth/login",
              {"email": "bo@example.com", "password": bo["temp_password"]})
    bo_c.call("POST", "/api/auth/password",
              {"current_password": bo["temp_password"], "new_password": "bo-secret-9x"},
              expect=204)
    ok("Bo changed her password")

    users = ana_c.json("GET", "/api/users")["users"]
    check(len(users) >= 3, "everyone can list users")
    check(all("email" not in u or not u["email"] for u in users),
          "the user list does not leak email addresses")
    ok("/api/users hides emails")

    ana_c.call("GET", "/api/admin/users", expect=403)
    ok("non-admins cannot reach admin endpoints")

    # ---------------------------------------------------- external send API
    section("external send API")

    def send(token, target, message=None, expect=201, query=None):
        path = f"/api/send/{urllib.parse.quote(target, safe='@')}"
        if query:
            path += "?" + urllib.parse.urlencode(query)
        raw = (message.encode(), "text/plain") if message is not None else None
        hdrs = {"Authorization": f"Bearer {token}"} if token else {}
        st, body, _ = anon_send.call("POST", path, raw=raw, headers=hdrs, expect=expect)
        return body.decode("utf-8", "replace").strip() if isinstance(body, bytes) else body

    anon_send = Client("script")
    ana_c.call("GET", "/api/admin/tokens", expect=403)
    ok("non-admins cannot see API tokens")

    made = admin.json("POST", "/api/admin/tokens",
                      {"name": "Deploy bot", "scope": "*"}, expect=201)
    secret = made["token"]
    check(secret.startswith("slk_"), "the token is prefixed so it is recognisable")
    check(made["api_token"]["scope"] == "*", "an unrestricted scope is stored as *")
    ok("admin minted a token")

    listed = admin.json("GET", "/api/admin/tokens")["tokens"]
    check(all("token" not in t for t in listed), "the secret is never listed again")
    ok("secrets are write-once")

    out = send(secret, "general", "posted by a script")
    check(out.startswith("ok "), f"a token can post to a channel (got {out!r})")
    ok("sending to a channel works")

    check(send(secret, "#general", None, query={"msg": "via query\nwith newline"}).startswith("ok "),
          "?msg= works and carries newlines")
    ok("?msg= form works")

    # The bot shows up as a normal author.
    gen = next(c for c in admin.json("GET", "/api/channels")["channels"]
               if c["name"] == "general")
    msgs = admin.json("GET", f"/api/channels/{gen['id']}/messages")["messages"]
    bot_msg = next((m for m in msgs if m["body"] == "posted by a script"), None)
    check(bot_msg is not None, "the API message landed in the channel")
    bot = next(u for u in admin.json("GET", "/api/users")["users"] if u["id"] == bot_msg["user_id"])
    check(bot["display_name"] == "Deploy bot", "it is authored by the token's named bot")
    ok("API messages render as a normal author")

    admin_users = admin.json("GET", "/api/admin/users")["users"]
    check(not any(u["display_name"] == "Deploy bot" for u in admin_users),
          "bots stay out of the people list")
    ok("bots are managed as tokens, not users")

    check("invalid token" in send("slk_wrong", "general", "x", expect=401), "a bad token is rejected")
    check("no token" in send(None, "general", "x", expect=401), "a missing token is rejected")
    check("no such channel" in send(secret, "nope", "x", expect=404), "unknown channels are reported")
    ok("send errors are plain text and specific")

    scoped = admin.json("POST", "/api/admin/tokens",
                        {"name": "CI", "scope": "eng, @Ana"}, expect=201)
    check(scoped["api_token"]["scope"] == "#eng, @ana", "the scope is normalised")
    admin.json("POST", "/api/channels", {"name": "eng"}, expect=201)
    check(send(scoped["token"], "eng", "allowed here").startswith("ok "), "an in-scope channel works")
    check("may not post" in send(scoped["token"], "general", "nope", expect=403),
          "an out-of-scope channel is refused")
    check(send(scoped["token"], "@Ana", "a direct message").startswith("ok "),
          "an in-scope DM works and opens the conversation")
    check("may not post" in send(scoped["token"], "@Bo", "nope", expect=403),
          "an out-of-scope DM is refused")
    ok("scopes restrict channels and DMs independently")

    admin.call("PATCH", f"/api/admin/tokens/{scoped['api_token']['id']}",
               {"is_active": False}, expect=200)
    check("disabled" in send(scoped["token"], "eng", "x", expect=403), "a disabled token cannot post")
    admin.call("DELETE", f"/api/admin/tokens/{scoped['api_token']['id']}", expect=204)
    check("invalid token" in send(scoped["token"], "eng", "x", expect=401), "a deleted token is gone")
    ok("tokens can be disabled and revoked")

    # ------------------------------------------------------------ workspace
    section("workspace identity")
    anon = Client("anonymous")
    ws = anon.json("GET", "/api/workspace")["workspace"]
    check(ws["name"] == "slock", "the workspace defaults to 'slock'")
    check(ws["icon_url"] == "", "there is no icon by default")
    ok("the workspace is readable without signing in (for the login page)")

    anon.call("GET", "/api/workspace/icon", expect=404)
    ok("an unset icon 404s")

    ana_c.call("PATCH", "/api/admin/workspace", {"name": "Acme"}, expect=403)
    ok("non-admins cannot rename the workspace")

    renamed = admin.json("PATCH", "/api/admin/workspace", {"name": "Acme Chat"})["workspace"]
    check(renamed["name"] == "Acme Chat", "an admin can rename the workspace")
    check(anon.json("GET", "/api/workspace")["workspace"]["name"] == "Acme Chat",
          "the new name is visible to the login page")
    ok("admins can rename the workspace")

    admin.call("PATCH", "/api/admin/workspace", {"name": ""}, expect=400)
    admin.call("PATCH", "/api/admin/workspace", {"name": "x" * 41}, expect=400)
    ok("workspace names are validated")

    icon_png = open("web/assets/icons/icon-192.png", "rb").read()
    ana_c.upload("/api/admin/workspace/icon", "logo.png", icon_png, expect=403)
    ok("non-admins cannot change the icon")

    withicon = admin.upload("/api/admin/workspace/icon", "logo.png", icon_png,
                            expect=200)["workspace"]
    check(withicon["icon_url"], "uploading an icon returns its URL")
    status, blob, hdrs = anon.call("GET", withicon["icon_url"])
    check(status == 200 and hdrs.get("Content-Type", "").startswith("image/"),
          "the icon is served, unauthenticated")
    ok("admins can set a workspace icon")

    admin.upload("/api/admin/workspace/icon", "notes.txt", b"nope" * 50, expect=400)
    ok("a non-image icon is rejected")

    cleared = admin.json("DELETE", "/api/admin/workspace/icon")["workspace"]
    check(cleared["icon_url"] == "", "removing the icon clears the URL")
    anon.call("GET", "/api/workspace/icon", expect=404)
    ok("admins can remove the icon again")

    # Put the default name back so later assertions read naturally.
    admin.call("PATCH", "/api/admin/workspace", {"name": "slock"}, expect=200)

    # ----------------------------------------------------- profile pictures
    section("profile pictures")
    check(all(u.get("avatar_url") == "" for u in users),
          "users start with no picture and fall back to initials")

    png = open("web/assets/icons/icon-512.png", "rb").read()
    updated = ana_c.upload("/api/users/me/avatar", "face.png", png, expect=200)
    check(updated["user"]["avatar_url"], "uploading a picture returns its URL")
    avatar_url = updated["user"]["avatar_url"]
    check("/api/users/" in avatar_url and "v=" in avatar_url,
          "the avatar URL is versioned for cache busting")
    ok("Ana uploaded a profile picture")

    status, blob, hdrs = bo_c.call("GET", avatar_url)
    check(status == 200, "another user can fetch the picture")
    check(hdrs.get("Content-Type", "").startswith("image/"), "it is served as an image")
    dims = jpeg_size(blob)
    check(dims is not None and max(dims) <= 480,
          f"the picture is downscaled, not served at full size (got {dims})")
    check("immutable" in hdrs.get("Cache-Control", ""), "versioned avatars cache hard")
    ok(f"the picture is served to everyone, downscaled to {dims[0]}x{dims[1]}")

    listed = next(u for u in bo_c.json("GET", "/api/users")["users"] if u["id"] == ana_id)
    check(listed["avatar_url"] == avatar_url, "the picture shows up in the user list")
    ok("other clients see the picture")

    bo_c.call("POST", "/api/users/me/avatar",
              raw=(b"not an image at all", "text/plain"), expect=400)
    ok("a non-multipart body is rejected")
    bo_c.upload("/api/users/me/avatar", "notes.txt", b"hello" * 100, expect=400)
    ok("a non-image file is rejected")

    cleared = ana_c.json("DELETE", "/api/users/me/avatar")
    check(cleared["user"]["avatar_url"] == "", "removing the picture clears the URL")
    ana_c.call("GET", f"/api/users/{ana_id}/avatar", expect=404)
    ok("Ana removed her picture and it stops being served")

    # Put it back so the rest of the run exercises the with-picture path.
    ana_c.upload("/api/users/me/avatar", "face.png", png, expect=200)
    ok("picture restored for the remaining checks")

    # ---------------------------------------------------------- channels
    section("channels")
    chans = admin.json("GET", "/api/channels")
    general = next((c for c in chans["channels"] if c["name"] == "general"), None)
    check(general is not None, "#general exists after bootstrap")
    ok("channel list works")

    design = admin.json("POST", "/api/channels",
                        {"name": "Design Team", "topic": "pixels"}, expect=201)["channel"]
    check(design["name"] == "design-team", "channel names are normalised")
    ok("created #design-team")

    admin.call("POST", "/api/channels", {"name": "design-team"}, expect=409)
    ok("duplicate channel name is a conflict")

    secret = admin.json("POST", "/api/channels",
                        {"name": "secret", "is_private": True}, expect=201)["channel"]
    ana_c.call("GET", f"/api/channels/{secret['id']}", expect=403)
    ana_c.call("GET", f"/api/channels/{secret['id']}/messages", expect=403)
    ok("private channels are invisible to non-members")

    ana_chans = ana_c.json("GET", "/api/channels")["channels"]
    check(not any(c["id"] == secret["id"] for c in ana_chans),
          "private channels are absent from the listing")
    check(any(c["id"] == design["id"] for c in ana_chans),
          "public channels are listed even when not joined")
    ok("channel visibility is correct")

    ana_c.call("POST", f"/api/channels/{design['id']}/join", expect=200)
    ok("Ana joined #design-team")

    # ---------------------------------------------------------- messages
    section("messages")
    ch = design["id"]
    m1 = ana_c.json("POST", f"/api/channels/{ch}/messages",
                    {"body": "the rounded corners look great", "client_id": "c-1"},
                    expect=201)["message"]
    check(m1["client_id"] == "c-1", "client_id is echoed back")
    ok("Ana posted a message")

    admin.json("POST", f"/api/channels/{ch}/messages", {"body": "agreed, shipping it"},
               expect=201)
    ok("admin auto-joined by posting")

    ana_c.call("POST", f"/api/channels/{ch}/messages", {"body": ""}, expect=400)
    ok("empty messages are rejected")

    listing = ana_c.json("GET", f"/api/channels/{ch}/messages")
    msgs = listing["messages"]
    check(len(msgs) == 2, "both messages come back")
    check(msgs[0]["id"] < msgs[1]["id"], "messages are ordered oldest first")
    check(msgs[0]["attachments"] == [] and msgs[0]["reactions"] == [],
          "attachments and reactions are always arrays")
    ok("message history reads correctly")

    # reactions
    admin.call("PUT", f"/api/messages/{m1['id']}/reactions/%F0%9F%91%8D", expect=204)
    ana_c.call("PUT", f"/api/messages/{m1['id']}/reactions/%F0%9F%91%8D", expect=204)
    ana_c.call("PUT", f"/api/messages/{m1['id']}/reactions/%F0%9F%91%8D", expect=204)
    got = ana_c.json("GET", f"/api/channels/{ch}/messages")["messages"][0]
    check(len(got["reactions"]) == 1, "reactions aggregate by emoji")
    check(got["reactions"][0]["count"] == 2, "a repeated reaction is idempotent")
    check(got["reactions"][0]["mine"], "mine is true for the caller")
    check(sorted(got["reactions"][0]["user_ids"]) == sorted([admin_id, ana_id]),
          "user_ids lists both reactors")
    ok("reactions aggregate correctly")

    ana_c.call("DELETE", f"/api/messages/{m1['id']}/reactions/%F0%9F%91%8D", expect=204)
    got = ana_c.json("GET", f"/api/channels/{ch}/messages")["messages"][0]
    check(got["reactions"][0]["count"] == 1, "removing a reaction decrements it")
    check(not got["reactions"][0]["mine"], "mine is false after removing")
    ok("reactions can be removed")

    # edit + delete permissions
    admin.call("PATCH", f"/api/messages/{m1['id']}", {"body": "hijacked"}, expect=403)
    ok("only the author may edit")
    edited = ana_c.json("PATCH", f"/api/messages/{m1['id']}",
                        {"body": "the rounded corners look great, actually"})["message"]
    check(edited["edited_at"], "edited_at is set")
    ok("the author can edit")

    doomed = ana_c.json("POST", f"/api/channels/{ch}/messages",
                        {"body": "delete me"}, expect=201)["message"]
    bo_c.call("DELETE", f"/api/messages/{doomed['id']}", expect=403)
    ok("a stranger cannot delete a message")
    admin.call("DELETE", f"/api/messages/{doomed['id']}", expect=204)
    after = ana_c.json("GET", f"/api/channels/{ch}/messages")["messages"]
    gone = next(m for m in after if m["id"] == doomed["id"])
    check(gone["deleted_at"] and gone["body"] == "", "deletes are soft and blank the body")
    ok("admins can delete anyone's message")

    # ------------------------------------------------------- attachments
    section("attachments")
    png = open("web/assets/icons/icon-512.png", "rb").read()
    att = ana_c.upload("/api/uploads", "logo.png", png)["attachment"]
    check(att["is_image"], "a PNG is recognised as an image")
    check(att["width"] == 512 and att["height"] == 512, "image dimensions are recorded")
    check(att["has_thumb"], "a thumbnail was generated")
    ok("uploaded an image")

    txt = ana_c.upload("/api/uploads", "notes.txt", b"hello slock\n" * 50)["attachment"]
    check(not txt["is_image"], "a text file is not an image")
    ok("uploaded a text file")

    bo_c.call("POST", f"/api/channels/{ch}/messages",
              {"body": "stealing your upload", "attachment_ids": [att["id"]]}, expect=400)
    ok("you cannot attach someone else's upload")

    withfile = ana_c.json("POST", f"/api/channels/{ch}/messages",
                          {"body": "here it is", "attachment_ids": [att["id"], txt["id"]]},
                          expect=201)["message"]
    check(len(withfile["attachments"]) == 2, "both attachments came back on the message")
    ok("attached files to a message")

    status, blob, hdrs = admin.call("GET", f"/api/files/{att['id']}/thumb/logo.png")
    check(status == 200, "the thumbnail downloads")
    check(hdrs.get("Content-Type", "").startswith("image/"), "thumbnails are served as images")
    dims = jpeg_size(blob)
    check(dims is not None, "the thumbnail is a decodable JPEG")
    check(max(dims) <= 480, f"the thumbnail is downscaled to <=480px (got {dims})")
    ok(f"image variants are served (thumb is {dims[0]}x{dims[1]})")

    status, blob, hdrs = admin.call("GET", f"/api/files/{txt['id']}/original/notes.txt")
    check(status == 200, "the text file downloads")
    check("attachment" in hdrs.get("Content-Disposition", ""),
          "non-images are served as downloads")
    ok("non-image downloads are forced as attachments")

    bo_c.call("GET", f"/api/files/{att['id']}/thumb/logo.png", expect=200)
    ok("channel members can read attachments")

    # ----------------------------------------------------------- search
    section("search")
    time.sleep(0.2)
    res = ana_c.json("GET", "/api/search?" + urllib.parse.urlencode({"q": "rounded corners"}))
    check(any(r["message"]["id"] == m1["id"] for r in res["results"]),
          "full-text search finds the message")
    check("<mark>" in "".join(r["snippet"] for r in res["results"]),
          "snippets highlight the match")
    ok("full-text search works")

    res = ana_c.json("GET", "/api/search?" + urllib.parse.urlencode({"q": "from:@Ana corners"}))
    check(res["results"] and all(r["user_id"] == ana_id for r in res["results"]),
          "from: filters by author")
    ok("from:@user filter works")

    res = ana_c.json("GET", "/api/search?" + urllib.parse.urlencode({"q": "in:#design-team"}))
    check(res["results"] and all(r["channel_id"] == ch for r in res["results"]),
          "in: filters by channel")
    ok("in:#channel filter works (with no free text)")

    res = ana_c.json("GET", "/api/search?" +
                     urllib.parse.urlencode({"q": "from:@ana in:#design-team shipping"}))
    check(res["results"] == [], "combined filters exclude non-matches")
    ok("combined filters work")

    admin.json("POST", f"/api/channels/{secret['id']}/messages",
               {"body": "classified pineapple"}, expect=201)
    res = ana_c.json("GET", "/api/search?" + urllib.parse.urlencode({"q": "pineapple"}))
    check(res["results"] == [], "search never leaks private channels")
    ok("search respects channel permissions")

    # HTML in a message must not survive into the snippet as live markup.
    ana_c.json("POST", f"/api/channels/{ch}/messages",
               {"body": "<img src=x onerror=alert(1)> xsstest"}, expect=201)
    res = ana_c.json("GET", "/api/search?" + urllib.parse.urlencode({"q": "xsstest"}))
    joined = "".join(r["snippet"] for r in res["results"])
    check("<img" not in joined, "snippets escape HTML from message bodies")
    ok("search snippets are XSS-safe")

    # -------------------------------------------------------------- DMs
    section("direct messages")
    dm = admin.json("POST", "/api/dms", {"user_id": ana_id})["channel"]
    check(dm["kind"] == "dm", "a DM channel is created")
    dm_again = admin.json("POST", "/api/dms", {"user_id": ana_id})["channel"]
    check(dm_again["id"] == dm["id"], "opening a DM twice reuses the channel")
    ok("DMs are get-or-create")

    admin.json("POST", f"/api/channels/{dm['id']}/messages", {"body": "psst"}, expect=201)
    bo_c.call("GET", f"/api/channels/{dm['id']}/messages", expect=403)
    ok("third parties cannot read a DM")

    ana_dms = ana_c.json("GET", "/api/channels")["dms"]
    mine = next((d for d in ana_dms if d["id"] == dm["id"]), None)
    check(mine is not None, "the DM appears in Ana's list")
    check(mine["unread_count"] == 1, "the DM shows one unread")
    check(mine["peer_user_id"] == admin_id, "peer_user_id points at the other person")
    ok("DM unread counts and peer are correct")

    last = ana_c.json("GET", f"/api/channels/{dm['id']}/messages")["messages"][-1]
    ana_c.call("POST", f"/api/channels/{dm['id']}/read",
               {"last_message_id": last["id"]}, expect=204)
    mine = next(d for d in ana_c.json("GET", "/api/channels")["dms"] if d["id"] == dm["id"])
    check(mine["unread_count"] == 0, "marking read clears the badge")
    ok("read state works")

    section("mute")
    ana_c.call("POST", f"/api/channels/{ch}/mute", {"muted": True}, expect=204)
    got = next(c for c in ana_c.json("GET", "/api/channels")["channels"] if c["id"] == ch)
    check(got["muted"], "muting a channel sticks")
    ana_c.call("POST", f"/api/channels/{ch}/mute", {"muted": False}, expect=204)
    got = next(c for c in ana_c.json("GET", "/api/channels")["channels"] if c["id"] == ch)
    check(not got["muted"], "unmuting a channel sticks")
    ok("mute round-trips per member")
    bo2_pre = Client("stranger")
    bo2_pre.json("POST", "/api/auth/login",
                 {"email": "ana@example.com", "password": "ana-secret-9x"})
    bo2_pre.call("POST", f"/api/channels/{secret['id']}/mute", {"muted": True}, expect=403)
    ok("you cannot mute a channel you are not in")

    # --------------------------------------------------------- realtime
    section("realtime (SSE)")
    stream = SSE(ana_c)
    stream.start()
    stream.ready.wait(timeout=10)
    check(stream.error is None, f"the event stream connected ({stream.error})")
    hello = stream.wait_for("hello", timeout=5)
    check(hello and hello.get("user_id") == ana_id, "hello identifies the user")
    ok("SSE stream opens with hello")

    time.sleep(0.3)
    sent = admin.json("POST", f"/api/channels/{ch}/messages",
                      {"body": "live from the other tab"}, expect=201)["message"]
    ev = stream.wait_for("message.new", timeout=10)
    check(ev is not None, "message.new arrived over SSE")
    check(ev["message"]["id"] == sent["id"], "the pushed message matches")
    check(ev["user"]["display_name"], "the event carries the author name")
    ok("new messages are pushed live")

    admin.call("PUT", f"/api/messages/{sent['id']}/reactions/%E2%9C%85", expect=204)
    ev = stream.wait_for("reaction", timeout=10)
    check(ev is not None and ev["message_id"] == sent["id"], "reaction events are pushed")
    ok("reaction events are pushed")

    admin.call("POST", f"/api/channels/{ch}/typing", expect=204)
    check(stream.wait_for("typing", timeout=5) is not None, "typing events are pushed")
    ok("typing events are pushed")
    stream.stop.set()

    # ------------------------------------------------------------ admin
    section("admin lifecycle")
    listed = admin.json("GET", "/api/admin/users")["users"]
    check(any(u["email"] == "bo@example.com" for u in listed),
          "the admin listing includes emails")
    ok("admin can list users with emails")

    reset = admin.json("POST", f"/api/admin/users/{bo_id}/reset-password")
    check(len(reset["temp_password"]) >= 12, "a new temporary password is issued")
    bo_c.call("GET", "/api/auth/me", expect=401)
    ok("resetting a password invalidates existing sessions")

    admin.call("PATCH", f"/api/admin/users/{bo_id}", {"is_active": False}, expect=200)
    bo2 = Client("bo2")
    bo2.call("POST", "/api/auth/login",
             {"email": "bo@example.com", "password": reset["temp_password"]}, expect=403)
    ok("deactivated users cannot sign in")

    # ------------------------------------------------------------ misc
    section("static and push")
    status, body, hdrs = admin.call("GET", "/")
    check(status == 200 and b"<" in body[:200], "the app shell is served")
    check("Content-Security-Policy" in hdrs, "security headers are present")
    ok("the client is served")

    status, manifest, mhdrs = admin.call("GET", "/manifest.webmanifest")
    check(status == 200 and isinstance(manifest, dict), "the web manifest is served as JSON")
    # Every response carries nosniff, so a manifest served as text/plain (Go has
    # no built-in type for .webmanifest) is rejected by Chrome and the install
    # prompt silently never appears.
    check(mhdrs.get("Content-Type", "").startswith("application/manifest+json"),
          f"the manifest is served as application/manifest+json, not "
          f"{mhdrs.get('Content-Type')!r} — nosniff makes a wrong type fatal")
    ok("the manifest has an installable content type")
    check(manifest.get("name") and manifest.get("icons"), "the manifest names the app and its icons")
    # The installed PWA should carry the workspace name, not the product name.
    ws_name = anon.json("GET", "/api/workspace")["workspace"]["name"]
    check(manifest["name"] == ws_name and manifest["short_name"] == ws_name,
          f"the manifest is named after the workspace ({manifest['name']!r} vs {ws_name!r})")
    check(manifest.get("display") == "standalone", "the manifest is installable")
    for icon in manifest["icons"]:
        st, _, _ = admin.call("GET", "/" + icon["src"].lstrip("/"))
        check(st == 200, f"manifest icon {icon['src']} exists")
    ok("the PWA manifest and every icon it lists are served")

    status, sw, hdrs = admin.call("GET", "/sw.js")
    check(status == 200, "the service worker is served")
    check(b"addEventListener" in sw, "the service worker is real JS, not the HTML fallback")
    check(b"push" in sw, "the service worker handles push")
    # The cache name must follow the build id, or a deploy leaves stale assets.
    check(b"searchParams" in sw and b"'v'" in sw,
          "the service worker keys its cache on the version from its own URL")
    # Chrome will not treat a site as installable without a fetch handler.
    check(b"'fetch'" in sw or b'"fetch"' in sw,
          "the service worker has a fetch handler (required for installability)")
    check(hdrs.get("Cache-Control", "") == "no-cache", "the service worker is never cached")
    ok("the service worker is served correctly")

    # The rest of Chrome's installability checklist, so a regression here shows
    # up in CI rather than as "it won't install on my phone".
    for page in ("/", "/login.html"):
        _, body, _ = admin.call("GET", page)
        text = body.decode("utf-8", "replace")
        check('rel="manifest"' in text, f"{page} links the web manifest")
    check(manifest.get("start_url") and manifest.get("scope"),
          "the manifest declares start_url and scope")
    sizes = {i.get("sizes") for i in manifest["icons"]}
    check("192x192" in sizes and "512x512" in sizes,
          f"the manifest offers 192px and 512px icons (has {sorted(sizes)})")
    check(any(i.get("purpose") == "maskable" for i in manifest["icons"]),
          "the manifest offers a maskable icon for Android adaptive shapes")
    ok("the install requirements are all met")

    # The markup and the JS were written against docs/DOM.md; verify the hooks
    # the client depends on actually exist in the shipped HTML.
    section("client contract (docs/DOM.md)")
    _, shell, _ = admin.call("GET", "/")
    html_text = shell.decode("utf-8", "replace")
    required_ids = [
        "app", "sidebar", "channel-list", "dm-list", "me-chip", "me-menu",
        "search-trigger", "new-channel-btn", "new-dm-btn", "main", "channel-header",
        "nav-toggle", "channel-title", "channel-topic", "channel-actions",
        "message-scroll", "message-list", "jump-latest",
        "typing-indicator", "composer", "composer-input", "attach-btn", "file-input",
        "send-btn", "attachment-tray", "composer-mode", "composer-cancel", "app-version",
        "palette", "palette-input", "palette-results",
        "lightbox", "lightbox-img", "modal-root", "toasts", "connection-banner",
    ]
    missing = [i for i in required_ids if f'id="{i}"' not in html_text]
    check(not missing, f"index.html is missing required ids: {missing}")
    ok(f"all {len(required_ids)} required element ids are present")

    required_templates = [
        "tpl-message", "tpl-day-divider", "tpl-channel-item", "tpl-dm-item",
        "tpl-attachment-image", "tpl-attachment-file", "tpl-reaction", "tpl-tray-item",
        "tpl-palette-item", "tpl-search-result", "tpl-toast", "tpl-member-row",
        "tpl-modal-new-channel", "tpl-modal-new-dm", "tpl-modal-members",
        "tpl-modal-profile", "tpl-modal-password", "tpl-modal-admin", "tpl-admin-row",
        "tpl-modal-confirm",
    ]
    missing = [t for t in required_templates if f'id="{t}"' not in html_text]
    check(not missing, f"index.html is missing templates: {missing}")
    ok(f"all {len(required_templates)} templates are present")

    # Profile pictures: every avatar spot needs the initials/image pair, and the
    # profile modal needs the upload controls.
    avatar_hooks = ["tok-form", "token_name", "token_scope", "tok-create", "tok-list",
                    "tok-result", "tok-secret", "tok-copy", "tok-error", "tpl-token-row",
                    "trow-name", "trow-scope", "trow-used", "trow-active-toggle", "trow-delete",
                    "avatar-initials", "avatar-img", "avatar-preview",
                    "avatar-upload", "avatar-file", "avatar-remove",
                    "workspace-logo", "workspace-icon", "ws-form", "workspace_name",
                    "ws-save", "ws-icon-preview", "ws-icon-upload", "ws-icon-file",
                    "ws-icon-remove", "ws-error"]
    missing = [h for h in avatar_hooks if h not in html_text]
    check(not missing, f"index.html is missing avatar/workspace hooks: {missing}")
    check(html_text.count("avatar-initials") >= 4,
          "every avatar spot (message, dm, member, me, preview) has an initials span")
    check(html_text.count("avatar-img") >= 4, "every avatar spot has an image element")
    ok("profile-picture hooks are present in the markup")

    _, appjs, _ = admin.call("GET", "/app.js")
    app_text = appjs.decode("utf-8", "replace")
    check("/api/users/me/avatar" in app_text, "the client can upload a profile picture")
    check("avatar_url" in app_text, "the client reads avatar_url")

    # The built-in mark is an <svg>, and `hidden` is an HTMLElement IDL property
    # only — assigning it on an SVG silently does nothing, leaving the fallback
    # logo sitting next to an admin's real one. It must go through the attribute.
    _, loginjs, _ = admin.call("GET", "/login.js")
    for name, text in (("app.js", app_text), ("login.js", loginjs.decode("utf-8", "replace"))):
        check("logo.hidden" not in text,
              f"{name} toggles the built-in logo via the hidden attribute, not the "
              f"SVG-invalid .hidden property")
    check("workspace-logo" in app_text, "the client swaps out the built-in logo")
    # Writing textContent onto the avatar element itself would delete the <img>.
    bad = re.findall(r"\b(?:msg|dm|member|me)Avatar\w*\.textContent\s*=", app_text)
    check(not bad, f"the client never writes textContent onto an avatar element: {bad}")
    ok("the client wires up profile pictures")

    # The mobile layout collapses #app to one column, but a media query adds no
    # specificity — so it must name the side classes or `body.side-left #app`
    # wins and the drawer's grid column eats half the phone screen.
    _, cssbytes, _ = admin.call("GET", "/style.css")
    css_text = cssbytes.decode("utf-8", "replace")
    m = re.search(r"@media\s*\(max-width:[^)]*\)\s*\{", css_text)
    check(m is not None, "style.css has a mobile media query")
    mobile_css = css_text[m.end():]
    app_rule = re.search(r"([^{}]*#app[^{}]*)\{[^{}]*grid-template-areas[^{}]*\}", mobile_css)
    check(app_rule is not None, "the mobile block overrides the #app grid")
    selectors = app_rule.group(1)
    for cls in ("side-left", "side-right"):
        check(f"body.{cls} #app" in selectors,
              f"the mobile #app override names body.{cls} so it out-ranks the "
              f"desktop rule (otherwise mobile renders as a split screen)")
    ok("the mobile layout override beats the sidebar-side rules")

    check('src="/app.js"' in html_text and "module" in html_text,
          "index.html loads app.js as a module")
    check("stylesheet" in html_text, "index.html links the stylesheet")
    # The server sends a strict CSP with no 'unsafe-inline' for scripts, so an
    # inline <script> would silently never run.
    inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", html_text)
    check(not inline, f"index.html has no inline <script> (CSP would block it): {inline}")
    ok("the shell wires up its assets and respects the CSP")

    for path, kind in [("/app.js", b"fetch"), ("/style.css", b"--"), ("/login.html", b"<form"),
                       ("/reset.html", b"<form"), ("/login.js", b"password")]:
        st, body, _ = admin.call("GET", path)
        check(st == 200 and kind in body, f"{path} is served with real content")
    ok("every client asset is served")

    ver = anon.json("GET", "/api/version")
    check(ver.get("version"), "the version endpoint reports a build id")
    check(re.fullmatch(r"(\d{4}-\d{2}-\d{2}-[0-9a-f]{7}(-dirty)?|dev)", ver["version"]),
          f"the version is yyyy-mm-dd-githash (or dev): {ver['version']!r}")
    ok(f"version endpoint works ({ver['version']})")

    hello = stream.wait_for("hello", timeout=5)
    check(hello.get("version") == ver["version"],
          "the SSE hello frame carries the same version (clients reload on a change)")
    ok("hello carries the build id")

    key = admin.json("GET", "/api/push/key")
    check("public_key" in key, "the push key endpoint responds")
    if key["public_key"]:
        admin.call("POST", "/api/push/subscribe", {
            "endpoint": "https://example.invalid/push/abc",
            "keys": {"p256dh": "BF" + "A" * 84, "auth": "A" * 22},
        }, expect=204)
        ok("push subscriptions can be registered")
    else:
        ok("push is disabled (no VAPID keys configured)")

    admin.call("POST", "/api/auth/logout", expect=204)
    admin.call("GET", "/api/channels", expect=401)
    ok("logout invalidates the session")

    print(f"\n\033[32mall {len(PASSED)} checks passed\033[0m")


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    main()

#!/usr/bin/env python3
"""
VRChat OTP Auto-Fetcher for QQ邮箱 (v2)
Connects to QQ邮箱 IMAP, finds the latest VRChat verification email,
extracts the 6-digit OTP code, and prints it to stdout.

Usage:
  python fetch-otp.py                        # 凭据自动从 Hermes .env 读取
  python fetch-otp.py <email> <auth_code>    # 或显式传参 (VRCX-0 兼容)

v2 changes:
  - 新增 IMAP ID 指令 (RFC 2971) — QQ/163 邮箱 LOGIN 后不发 ID 可能 BYE 断开
  - 凭据自动从 ~/AppData/Local/hermes/.env 读取, 也可传参覆盖
  - 提取逻辑增强: Subject 优先, 正文兜底, 兼容 6 位含空格格式

Returns: <6-digit-otp> on success, exits with code 1 on failure.
"""
import imaplib
import email
import re
import sys
import os
import datetime
from email.utils import parsedate_to_datetime


def load_env(path):
    env = {}
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def send_imap_id(mail):
    """Send RFC 2971 IMAP ID. QQ/163 require this after LOGIN, else
    UID SEARCH/FETCH may return 'BYE Unsafe Login'. Swallow failures."""
    try:
        mail.xatom("ID", '("name" "hermes-otp" "version" "2.0" "vendor" "NousResearch")')
    except Exception:
        pass


def parse_email_date(date_str):
    """Parse email Date header to datetime. Returns None on failure."""
    if not date_str:
        return None
    try:
        return parsedate_to_datetime(date_str)
    except Exception:
        return None


def is_recent(date_val, max_age_minutes=10):
    """Check if a datetime is within max_age_minutes of now."""
    if date_val is None:
        return False
    now = datetime.datetime.now(datetime.timezone.utc)
    if date_val.tzinfo is None:
        date_val = date_val.replace(tzinfo=datetime.timezone.utc)
    age = (now - date_val).total_seconds()
    return 0 <= age <= max_age_minutes * 60


def get_email_date(mail, msg_id):
    """Fetch Date header from a message. Returns datetime or None."""
    try:
        status, data = mail.fetch(msg_id, '(BODY.PEEK[HEADER.FIELDS (DATE)])')
        if status != 'OK':
            return None
        for item in data:
            if isinstance(item, tuple):
                hdr_bytes = item[1]
                if hdr_bytes:
                    hdr_text = hdr_bytes.decode('utf-8', errors='ignore')
                    m = re.search(r'^Date:\s*(.+)', hdr_text, re.MULTILINE | re.IGNORECASE)
                    if m:
                        return parse_email_date(m.group(1).strip())
    except Exception:
        pass
    return None


def fetch_otp(email_addr, auth_code, imap_host='imap.qq.com', imap_port=993):
    """Connect to IMAP, find latest VRChat OTP email, return the 6-digit code."""
    try:
        mail = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=30)
        mail.login(email_addr, auth_code)
        send_imap_id(mail)
        mail.select('INBOX')

        since = (datetime.datetime.now() - datetime.timedelta(days=7)).strftime('%d-%b-%Y')

        status, msgs = mail.search(None, f'(FROM "vrchat" SINCE {since})')
        if not msgs[0]:
            status, msgs = mail.search(None, f'(FROM "VRChat" SINCE {since})')
        if not msgs[0]:
            status, msgs = mail.search(None, f'(SUBJECT "One-Time Code" SINCE {since})')
        if not msgs[0]:
            # 兜底: 扫最近 10 封的头部
            status, msgs = mail.search(None, 'ALL')
            if msgs[0]:
                all_ids = msgs[0].split()
                found_id = None
                for rid in reversed(all_ids[-10:]):
                    status, data = mail.fetch(rid, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])')
                    if status == 'OK':
                        hdr = data[0][1].decode('utf-8', errors='ignore')
                        if 'vrchat' in hdr.lower() or 'one-time' in hdr.lower() or 'code' in hdr.lower():
                            found_id = rid
                            break
                msgs = (status, found_id)
            else:
                msgs = (status, None)

        if not msgs[0]:
            mail.logout()
            return None

        all_ids = msgs[0].split()
        latest_id = None
        # 检查最近 5 封，取最新且 10 分钟内的有效验证码，避免 IMAP 同步延迟取到旧码
        for rid in reversed(all_ids[-5:]):
            date_val = get_email_date(mail, rid)
            if date_val and is_recent(date_val):
                latest_id = rid
                break

        if not latest_id:
            mail.logout()
            return None

        status, data = mail.fetch(latest_id, '(RFC822)')
        mail.logout()

        if status != 'OK':
            return None

        raw = email.message_from_bytes(data[0][1])

        # Try Subject first: "Your One-Time Code is 396357"
        subject = raw['Subject'] or ''
        codes = re.findall(r'\b(\d{6})\b', subject)
        if codes:
            return codes[-1]

        # Then body
        body = ''
        if raw.is_multipart():
            for part in raw.walk():
                if part.get_content_type() == 'text/plain':
                    body = part.get_payload(decode=True)
                    body = body.decode('utf-8', errors='ignore') if body else ''
                    break
        else:
            body = raw.get_payload(decode=True)
            body = body.decode('utf-8', errors='ignore') if body else ''

        codes = re.findall(r'\b(\d{6})\b', body)
        return codes[-1] if codes else None

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return None


if __name__ == '__main__':
    if len(sys.argv) >= 3:
        addr_arg, code_arg = sys.argv[1], sys.argv[2]
    else:
        # 自动从 Hermes .env 读凭据
        env_path = os.path.expanduser("~/AppData/Local/hermes/.env")
        try:
            env = load_env(env_path)
            addr_arg, code_arg = env.get("EMAIL_ADDRESS", ""), env.get("EMAIL_PASSWORD", "")
        except Exception as e:
            print(f"ERROR: cannot read .env ({env_path}): {e}", file=sys.stderr)
            sys.exit(1)
        if not addr_arg or not code_arg:
            print("ERROR: EMAIL_ADDRESS/EMAIL_PASSWORD missing in .env", file=sys.stderr)
            sys.exit(1)

    otp = fetch_otp(addr_arg, code_arg)
    if otp:
        print(otp)
        sys.exit(0)
    else:
        print("FAILED", file=sys.stderr)
        sys.exit(1)

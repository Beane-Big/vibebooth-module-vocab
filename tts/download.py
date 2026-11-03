# 构建镜像时下载文件（只用标准库，装依赖之前就能用）：每 10% 打印一次进度；
# 网络不稳（连接超时、中途断开）时自动重试，已经下载的部分不丢，接着往下下。
import http.client
import os
import time
import urllib.error
import urllib.request

TRIES = 8


def download(url: str, dest: str) -> None:
    tmp = dest + ".part"
    print("下载", url, flush=True)
    for attempt in range(1, TRIES + 1):
        done = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        req = urllib.request.Request(url, headers={"Range": f"bytes={done}-"} if done else {})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status != 206:  # 服务器没按续传返回，就从头下
                    done = 0
                total = done + int(r.headers.get("Content-Length") or 0)
                shown = -1
                with open(tmp, "ab" if done else "wb") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        pct = done * 100 // total // 10 * 10 if total else -1
                        if pct > shown:
                            print(f"  {pct}%（{done / 1e6:.1f} / {total / 1e6:.1f} MB）", flush=True)
                            shown = pct
            if total and done < total:
                raise http.client.IncompleteRead(b"", total - done)
            os.replace(tmp, dest)
            return
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429:  # 地址错了之类，重试也没用
                raise
            err = e
        except (OSError, http.client.HTTPException) as e:
            err = e
        if attempt == TRIES:
            raise SystemExit(f"下载失败（试了 {TRIES} 次）：{url}：{err}")
        wait = min(2**attempt, 30)
        print(f"  出错：{err}，{wait} 秒后重试（第 {attempt} 次）", flush=True)
        time.sleep(wait)

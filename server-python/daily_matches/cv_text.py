"""PDF CV → plain text, once per CV version.

The extension stores a PDF as "[PDF_BASE64:…]" (V1 behaviour), which can't be
embedded or matched. Claude reads the PDF as a document block and transcribes
it. It handles Hebrew right-to-left layouts that text-layer extractors often
scramble, and scanned PDFs with no text layer at all. The text goes back to the
extension, which keeps it, so each PDF is read once.

The anthropic SDK is pinned at 0.34.2, older than its typed document blocks,
but its request transform passes unknown dict shapes through unchanged, and
the API accepts them.
"""
import base64
import binascii
import importlib

from daily_matches import config


class PdfRejected(ValueError):
    """Not a usable PDF; the message is safe to show the user."""


PROMPT = """\
Transcribe the full text of this CV / resume exactly as written, in natural \
reading order. Keep the original language (Hebrew stays Hebrew, English stays \
English), line breaks between sections and entries, and bullet points as "• ". \
Do not summarize, translate, correct or add anything. Output only the CV text."""


def decode_pdf(b64: str) -> bytes:
    try:
        raw = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError):
        raise PdfRejected("קובץ ה-PDF פגום ולא ניתן לקריאה.")
    if len(raw) > config.MAX_PDF_BYTES:
        raise PdfRejected("קובץ ה-PDF גדול מדי (מעל 5MB).")
    if not raw.startswith(b"%PDF"):
        raise PdfRejected("הקובץ אינו PDF תקין.")
    return raw


async def extract_pdf_text(b64: str) -> str:
    """Raises PdfRejected for a bad file, or the mapped HTTPException
    (main.ai_error) when the AI call fails."""
    decode_pdf(b64)
    main = importlib.import_module("main")
    clean_b64 = "".join(b64.split())
    try:
        message = await main._ac().messages.create(
            model=config.LLM_MODEL,
            max_tokens=8000,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "document",
                     "source": {"type": "base64", "media_type": "application/pdf", "data": clean_b64}},
                    {"type": "text", "text": PROMPT},
                ],
            }],
        )
    except Exception as exc:  # noqa: BLE001
        raise main.ai_error(exc)
    text = "".join(getattr(b, "text", "") for b in message.content).strip()
    if len(text) < config.MIN_CV_CHARS:
        raise PdfRejected("לא הצלחנו לקרוא טקסט מקובץ ה-PDF. נסי להעלות DOCX או TXT.")
    return text

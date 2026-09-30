import re
from pathlib import Path
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS

BASE_DIR = Path(__file__).resolve().parent
DOCS_DIR = BASE_DIR / "rag_docs"
INDEX_DIR = BASE_DIR / "rag_index"
EMBED_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
FIRST_TRANSCRIPT = re.compile(r"=+\s*\n\s*CLASS TRANSCRIPT \d+ OF \d+")

_embeddings = HuggingFaceEmbeddings(model_name=EMBED_MODEL_NAME)
_db = None


def _load_overview() -> str:
    # Everything above the first CLASS TRANSCRIPT header: facts, schedule, day-by-day notes
    sections = []
    for f in sorted(DOCS_DIR.glob("*.txt")):
        text = f.read_text(encoding="utf-8", errors="ignore")
        match = FIRST_TRANSCRIPT.search(text)
        if match:
            sections.append(text[:match.start()].strip())
    return "\n\n".join(s for s in sections if s)


_overview = _load_overview()
print(f"[RAG] Overview loaded: {len(_overview)} characters")


def _load_db():
    global _db
    if _db is None:
        if not INDEX_DIR.exists():
            raise RuntimeError("RAG index not found. Run: python build_rag_index.py")
        _db = FAISS.load_local(str(INDEX_DIR), _embeddings, allow_dangerous_deserialization=True)
    return _db


def get_rag_context(query: str, k: int = 8) -> str:
    try:
        docs = _load_db().similarity_search(query, k=k + 4)
    except Exception as e:
        print(f"[RAG Error] {e}")
        return _overview

    # The overview is already included in full, so keep only transcript pieces here
    excerpts = [d.page_content.strip() for d in docs if d.metadata.get("class_number", 0) != 0][:k]
    return f"BOOTCAMP OVERVIEW:\n{_overview}\n\nCLASS DISCUSSION EXCERPTS:\n" + "\n\n".join(excerpts)
import re
import hashlib
from pathlib import Path
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS

BASE_DIR = Path(__file__).resolve().parent
DOCS_DIR = BASE_DIR / "rag_docs"
INDEX_DIR = BASE_DIR / "rag_index"
EMBED_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

HEADER = re.compile(r"=+\s*\n\s*CLASS TRANSCRIPT (\d+) OF (\d+)\s*\n=+")
TIMESTAMP = re.compile(r"^\d{1,2}:\d{2}:\d{2}$")


def to_turns(body: str) -> list[str]:
    lines = [l.strip() for l in body.splitlines()]
    turns, speaker, stamp, words = [], None, "", []

    def save():
        if speaker and words:
            prefix = f"[{stamp}] " if stamp else ""
            turns.append(f"{prefix}{speaker}: {' '.join(words)}")

    i = 0
    while i < len(lines):
        line = lines[i]
        # Speaker names appear twice in a row
        if line and len(line) <= 40 and i + 1 < len(lines) and lines[i + 1] == line:
            save()
            speaker, stamp, words = line, "", []
            i += 2
            if i < len(lines) and TIMESTAMP.match(lines[i]):
                stamp = lines[i]
                i += 1
            continue
        if line:
            words.append(line)
        i += 1
    save()
    return turns


def load_documents() -> list[Document]:
    files = sorted(DOCS_DIR.glob("*.txt"))
    if not files:
        raise SystemExit(f"No .txt files in {DOCS_DIR}")

    docs, seen = [], set()
    for f in files:
        parts = HEADER.split(f.read_text(encoding="utf-8"))

        # Everything above the first CLASS TRANSCRIPT header = schedule + day-by-day notes
        notes = parts[0].strip()
        if notes:
            docs.append(Document(
                page_content=notes,
                metadata={"class_number": 0, "total_classes": 0, "source_file": f.name},
            ))
            print("Loaded class schedule and day-by-day notes")

        # parts = [notes, number, total, body, number, total, body, ...]
        for j in range(1, len(parts), 3):
            number, total, body = parts[j], parts[j + 1], parts[j + 2]
            turns = to_turns(body)
            fingerprint = hashlib.md5("\n".join(turns).encode()).hexdigest()
            if fingerprint in seen:
                print(f"Skipped Class transcript {number}: duplicate of an earlier one")
                continue
            seen.add(fingerprint)
            docs.append(Document(
                page_content="\n".join(turns),
                metadata={"class_number": int(number), "total_classes": int(total), "source_file": f.name},
            ))
            print(f"Loaded Class transcript {number} of {total}: {len(turns)} speaker turns")
    return docs


def main():
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    documents = load_documents()

    splitter = RecursiveCharacterTextSplitter(chunk_size=800, chunk_overlap=150, separators=["\n", ". ", " "])
    chunks = splitter.split_documents(documents)
    for c in chunks:
        n = c.metadata["class_number"]
        label = "Class schedule and day-by-day notes" if n == 0 else f"Class transcript {n}"
        c.page_content = f"{label}:\n{c.page_content}"
    print(f"{len(documents)} documents -> {len(chunks)} chunks")

    db = FAISS.from_documents(chunks, HuggingFaceEmbeddings(model_name=EMBED_MODEL_NAME))
    db.save_local(str(INDEX_DIR))
    print(f"Index saved to {INDEX_DIR}")


if __name__ == "__main__":
    main()
"""CLI for one-way anonymization of text, files, and directories."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .engine import anonymize
from .detectors import Span

TEXT_EXT = {".txt", ".md", ".csv", ".tsv", ".json", ".log", ".html", ".xml", ".yaml", ".yml"}


def _read_input(args) -> tuple[str, str]:
    if args.text is not None:
        return args.text, "-"
    if args.file is not None:
        p = Path(args.file)
        return p.read_text(encoding="utf-8", errors="replace"), str(p)
    if args.stdin:
        data = sys.stdin.read()
        return data, "<stdin>"
    data = sys.stdin.read()
    return data, "<stdin>"


def _extra_spans(text: str, args) -> tuple[list[Span], str | None]:
    if not args.llm:
        return [], None
    from . import llm

    spans = llm.llm_spans(text, model=args.model)
    return spans, None


def _report(result, args) -> dict:
    report = {
        "counts": result.counts,
        "total": len(result.replacements),
        "replacements": [
            {"label": r.label, "placeholder": r.placeholder, "source": r.source, "score": round(r.score, 3)}
            for r in result.replacements
        ],
    }
    if args.json and args.with_originals:
        for item, r in zip(report["replacements"], result.replacements):
            item["original"] = r.original
            item["start"] = r.start
            item["end"] = r.end
    return report


def _process(text: str, args) -> tuple[str, dict]:
    include = set(args.include.split(",")) if args.include else None
    exclude = set(args.exclude.split(",")) if args.exclude else None

    # Reuse the warm daemon when available so the model stays loaded and
    # placeholder numbering persists across requests.
    if not args.llm:
        from . import serve as serve_mod

        resp = serve_mod.request(
            text,
            {
                "lang": args.lang,
                "use_ner": not args.no_ner,
                "threshold": args.threshold,
                "style": args.style,
                "include": sorted(include) if include else None,
                "exclude": sorted(exclude) if exclude else None,
            },
        )
        if resp and resp.get("ok"):
            from .engine import Result, Replacement

            result = Result(
                resp["text"],
                [Replacement(**{**r, "score": r.get("score", 0.0)}) for r in resp.get("replacements", [])],
            )
            if args.task and not args.no_task_llm:
                from . import llm

                result.text = llm.run_task(result.text, args.task, model=args.model)
            return result.text, _report(result, args)

    extra, _ = _extra_spans(text, args)
    result = anonymize(
        text,
        lang=args.lang,
        use_ner=not args.no_ner,
        threshold=args.threshold,
        style=args.style,
        include=include,
        exclude=exclude,
        extra_spans=extra,
    )

    if args.task and not args.no_task_llm:
        from . import llm

        result.text = llm.run_task(result.text, args.task, model=args.model)

    return result.text, _report(result, args)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="anon", description="Local PII anonymizer (DE+EN), one-way.")
    p.add_argument("--text", help="Text to anonymize")
    p.add_argument("--file", help="Anonymize a file")
    p.add_argument("--dir", help="Anonymize a directory recursively")
    p.add_argument("--out", help="Output file/directory (default stdout)")
    p.add_argument("--suffix", default=".anon", help="Suffix for --dir output files (default .anon)")
    p.add_argument("--lang", choices=["de", "en", "both"], default="both")
    p.add_argument("--no-ner", action="store_true", help="deterministic rules only (no NER)")
    p.add_argument("--threshold", type=float, default=0.30, help="NER threshold (default 0.30)")
    p.add_argument("--style", choices=["placeholder", "numbered"], default="numbered")
    p.add_argument("--include", help="only these labels (comma)")
    p.add_argument("--exclude", help="exclude these labels (comma)")
    p.add_argument("--llm", action="store_true", help="extra LLM context pass (Ollama)")
    p.add_argument("--task", help="prompt run on the text after anonymization")
    p.add_argument("--no-task-llm", action="store_true")
    p.add_argument("--model", default="qwen2.5:7b")
    p.add_argument("--json", action="store_true", help="JSON report (stdout is JSON only with --out text)")
    p.add_argument("--with-originals", action="store_true", help="keep original values in JSON")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--stdin", action="store_true", help="read from stdin")
    p.add_argument("--serve", action="store_true", help="start the warm-model daemon (Unix socket)")
    args = p.parse_args(argv)

    if args.serve:
        from .serve import serve

        serve()
        return 0

    if args.dir:
        src = Path(args.dir)
        dst = Path(args.out) if args.out else src
        n = 0
        for f in src.rglob("*"):
            if f.is_file() and f.suffix.lower() in TEXT_EXT:
                rel = f.relative_to(src)
                target = (dst / rel)
                target = target.with_name(target.name + args.suffix)
                target.parent.mkdir(parents=True, exist_ok=True)
                out_text, report = _process(f.read_text(encoding="utf-8", errors="replace"), args)
                target.write_text(out_text, encoding="utf-8")
                n += 1
                if args.json:
                    print(json.dumps({"file": str(f), "out": str(target), **report}, ensure_ascii=False))
                elif not args.quiet:
                    print(f"{f} -> {target}  ({report['total']} replacements)", file=sys.stderr)
        if not args.quiet:
            print(f"{n} file(s) anonymized.", file=sys.stderr)
        return 0

    text, src_name = _read_input(args)
    out_text, report = _process(text, args)

    if args.out:
        Path(args.out).write_text(out_text, encoding="utf-8")
        if args.json:
            print(json.dumps({"source": src_name, "out": args.out, **report}, ensure_ascii=False))
        elif not args.quiet:
            print(f"{src_name} -> {args.out}  ({report['total']} replacements)", file=sys.stderr)
    else:
        if args.json:
            print(json.dumps({"source": src_name, "text": out_text, **report}, ensure_ascii=False, indent=2))
        else:
            sys.stdout.write(out_text)
            if not out_text.endswith("\n"):
                sys.stdout.write("\n")
            if not args.quiet:
                print(f"\n[{report['total']} replacements: {report['counts']}]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

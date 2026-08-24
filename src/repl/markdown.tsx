import React from "react";
import { Box, Text } from "ink";

interface Segment {
  text: string;
  bold?: boolean;
  code?: boolean;
}

function parseInline(line: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) segments.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) segments.push({ text: tok.slice(1, -1), code: true });
    else segments.push({ text: tok.slice(1, -1), bold: false });
    last = m.index + tok.length;
  }
  if (last < line.length) segments.push({ text: line.slice(last) });
  return segments;
}

function Inline(props: { line: string }): React.ReactElement {
  const segments = parseInline(props.line);
  return (
    <Text>
      {segments.map((s, i) =>
        s.code ? (
          <Text key={i} color="green">
            {s.text}
          </Text>
        ) : s.bold ? (
          <Text key={i} bold>
            {s.text}
          </Text>
        ) : (
          <Text key={i}>{s.text}</Text>
        ),
      )}
    </Text>
  );
}

export function MarkdownView(props: { content: string; color?: string }): React.ReactElement {
  const lines = props.content.split("\n");
  const out: React.ReactElement[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let codeKey = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        out.push(
          <Box key={`code${codeKey++}`} flexDirection="column" marginX={1} borderStyle="round" borderColor="gray">
            {codeLines.map((cl, j) => (
              <Text key={j} color="green">{cl}</Text>
            ))}
          </Box>,
        );
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(
        <Text key={i} bold color={props.color ?? "magentaBright"}>
          {" ".repeat(0)}
          {heading[2]}
        </Text>,
      );
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(
        <Text key={i}>
          {"  "}
          <Text color="cyan">•</Text> <Inline line={bullet[2] ?? ""}/>
        </Text>,
      );
      continue;
    }
    const numbered = line.match(/^\s*(\d+\.)\s+(.*)$/);
    if (numbered) {
      out.push(
        <Text key={i}>
          {"  "}
          <Text color="cyan">{numbered[1]}</Text> <Inline line={numbered[2] ?? ""}/>
        </Text>,
      );
      continue;
    }
    if (line.trim() === "") {
      out.push(<Text key={i}> </Text>);
      continue;
    }
    out.push(<Inline key={i} line={line} />);
  }
  if (codeLines.length > 0) {
    out.push(
      <Box key={`codetail`} flexDirection="column">
        {codeLines.map((cl, j) => (
          <Text key={j} color="green">{cl}</Text>
        ))}
      </Box>,
    );
  }
  return (
    <Box flexDirection="column" marginTop={0}>
      {out}
    </Box>
  );
}

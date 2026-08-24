import React, { useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { AskQuestion, PermissionRequest } from "../types.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner(props: { label?: string }): React.ReactElement {
  const [frame, setFrame] = React.useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color="yellowBright">
      {FRAMES[frame]} {props.label ?? ""}
    </Text>
  );
}

export function PermissionDialog(props: {
  request: PermissionRequest;
  onAnswer: (answer: { allow: boolean; persist?: "session" | "always" }) => void;
}): React.ReactElement {
  const options = ["Yes", "Yes, and don't ask again for similar", "No (tell Ox what to do differently)"];
  const [selected, setSelected] = React.useState(0);
  const inputRef = useRef("");

  useInput(
    (data, key) => {
      if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSelected((s) => Math.min(options.length - 1, s + 1));
      else if (key.return) {
        const choice = selected;
        props.onAnswer({
          allow: choice !== 2,
          persist: choice === 1 ? "always" : choice === 0 ? undefined : undefined,
        });
      } else if (key.escape) {
        props.onAnswer({ allow: false });
      } else {
        void inputRef;
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={0}>
      <Text bold color="yellow">
        Permission needed
      </Text>
      <Text>
        <Text bold>{props.request.toolName}</Text>: {props.request.summary}
      </Text>
      <Box flexDirection="column" marginTop={0}>
        {options.map((opt, i) => (
          <Text key={opt} color={i === selected ? "yellowBright" : undefined}>
            {i === selected ? "❯ " : "  "}
            {opt}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function AskDialog(props: {
  questions: AskQuestion[];
  onAnswers: (answers: Record<string, string>) => void;
}): React.ReactElement {
  const [qIndex, setQIndex] = React.useState(0);
  const [optionIndex, setOptionIndex] = React.useState(0);
  const answersRef = useRef<Record<string, string>>({});
  const question = props.questions[qIndex];

  useInput((_data, key) => {
    if (!question) return;
    if (key.upArrow) setOptionIndex((o) => Math.max(0, o - 1));
    else if (key.downArrow) setOptionIndex((o) => Math.min(question.options.length - 1, o + 1));
    else if (key.return) {
      const opt = question.options[optionIndex];
      if (!opt) return;
      answersRef.current[question.question] =
        question.multiSelect && answersRef.current[question.question]
          ? `${answersRef.current[question.question]}, ${opt.label}`
          : opt.label;
      if (question.multiSelect && _data === ",") return;
      if (qIndex + 1 < props.questions.length) {
        setQIndex(qIndex + 1);
        setOptionIndex(0);
      } else {
        props.onAnswers(answersRef.current);
      }
    } else if (key.escape) {
      props.onAnswers(answersRef.current);
    }
  });

  if (!question) return <Text>No questions</Text>;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {question.header}
      </Text>
      <Text>{question.question}</Text>
      <Box flexDirection="column">
        {question.options.map((opt, i) => (
          <Box key={opt.label}>
            <Text color={i === optionIndex ? "yellowBright" : undefined}>
              {i === optionIndex ? "❯ " : "  "}
              {opt.label}
              {opt.description ? ` — ${opt.description}` : ""}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

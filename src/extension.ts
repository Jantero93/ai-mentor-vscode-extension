import * as vscode from "vscode";

const REVIEW_INTERVAL_MS = 5 * 60 * 1_000;
const QUESTION_COOLDOWN_MS = 15 * 60 * 1_000;
const MIN_CHANGED_CHARACTERS = 100;

let changedCharacters = 0;
let changedFiles = new Set<string>();

let lastReviewTime = 0;
let lastQuestionTime = 0;

let mentorStarted = false;
let selectedModel: vscode.LanguageModelChat | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("AI Code Mentor activated");

  context.subscriptions.push(
    vscode.commands.registerCommand("ai-code-mentor.start", async () => {
      await startMentor();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ai-code-mentor.selectModel", async () => {
      await selectModel();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!mentorStarted) {
        return;
      }

      if (event.document.uri.scheme !== "file") {
        return;
      }

      for (const change of event.contentChanges) {
        changedCharacters += change.text.length;
        changedCharacters += change.rangeLength;
      }

      changedFiles.add(event.document.uri.toString());
    }),
  );

  const timer = setInterval(() => checkForReview(), 30_000);

  context.subscriptions.push({
    dispose: () => clearInterval(timer),
  });
}

async function startMentor(): Promise<void> {
  const model = selectedModel ?? (await selectModel());

  if (!model) {
    vscode.window.showErrorMessage(
      "No language models are available.",
    );

    return;
  }

  mentorStarted = true;

  vscode.window.showInformationMessage(
    "AI Code Mentor is now watching your coding activity.",
  );
}

async function checkForReview(): Promise<void> {
  if (!mentorStarted) {
    return;
  }

  const now = Date.now();

  // Don't review too frequently.
  if (now - lastReviewTime < REVIEW_INTERVAL_MS) {
    return;
  }

  // Don't ask another question too soon.
  if (now - lastQuestionTime < QUESTION_COOLDOWN_MS) {
    return;
  }

  // Don't bother the AI if hardly anything changed (diff character count).
  if (changedCharacters < MIN_CHANGED_CHARACTERS) {
    return;
  }

  // Don't interrupt while the user is actively typing.
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }

  lastReviewTime = now;

  await reviewCurrentCode();
}

async function reviewCurrentCode(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }

  const document = editor.document;

  if (document.uri.scheme !== "file") {
    return;
  }

  const code = document.getText();

  if (!code.trim()) {
    return;
  }

  const model = await getChatModel();

  if (!model) {
    return;
  }

  const prompt = `
You are an experienced senior software engineer acting as
a Socratic coding mentor.

The developer is currently writing code.

Your job is NOT to fix the code.

Your job is to decide whether there is a genuinely useful
engineering question worth asking the developer.

You should challenge meaningful engineering decisions such as:

- architecture
- design
- unnecessary abstractions
- hidden coupling
- incorrect assumptions
- performance
- database usage
- concurrency
- error handling
- security
- testability
- maintainability
- responsibility boundaries
- unnecessary complexity

Do NOT ask a question merely because you can.

Do NOT nitpick formatting or personal coding style.

Do NOT ask generic questions such as:
"Have you considered edge cases?"

Instead, make the question specific to the actual code.

If there is nothing worth challenging, respond with exactly:

NO_QUESTION

If there is something worth challenging, respond with
ONE concise Socratic question.

Do not provide the solution.

Do not explain the problem.

Do not rewrite the code.

Current code:

${code}
`;

  try {
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];

    const response = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token,
    );

    let result = "";

    for await (const chunk of response.text) {
      result += chunk;
    }

    result = result.trim();

    if (!result || result === "NO_QUESTION") {
      resetActivity();

      return;
    }

    lastQuestionTime = Date.now();

    await askDeveloper(result);

    resetActivity();
  } catch (error) {
    console.error("AI Code Mentor error:", error);
  }
}

async function askDeveloper(question: string): Promise<void> {
  const answer = await vscode.window.showInputBox({
    title: "AI Code Mentor",
    prompt: question,
    placeHolder: "Explain your reasoning...",
    ignoreFocusOut: true,
  });

  if (!answer) {
    return;
  }

  await followUp(question, answer);
}

async function followUp(question: string, answer: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }

  const model = await getChatModel();

  if (!model) {
    return;
  }

  const prompt = `
You are a senior software engineering mentor.

You asked the developer:

"${question}"

The developer answered:

"${answer}"

Evaluate their reasoning.

If the explanation adequately resolves the concern,
respond with exactly:

NO_FOLLOW_UP

If there is another important engineering concern,
ask ONE concise follow-up question.

Do not solve the problem.

Do not nitpick.

Do not ask generic questions.

Current code:

${editor.document.getText()}
`;

  try {
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];

    const response = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token,
    );

    let result = "";

    for await (const chunk of response.text) {
      result += chunk;
    }

    result = result.trim();

    if (!result || result === "NO_FOLLOW_UP") {
      vscode.window.showInformationMessage(
        "AI Code Mentor: Your reasoning makes sense.",
      );

      return;
    }

    const followUpAnswer = await vscode.window.showInputBox({
      title: "AI Code Mentor — Follow-up",
      prompt: result,
      placeHolder: "Explain your reasoning...",
      ignoreFocusOut: true,
    });

    if (followUpAnswer) {
      // We deliberately stop after one follow-up for now.
      vscode.window.showInformationMessage(
        "AI Code Mentor: Thanks. Continuing to monitor.",
      );
    }
  } catch (error) {
    console.error("AI Code Mentor follow-up error:", error);
  }
}

async function getChatModel(): Promise<vscode.LanguageModelChat | undefined> {
  if (selectedModel) {
    return selectedModel;
  }

  const models = await getAvailableModels();

  return models[0];
}

async function selectModel(): Promise<vscode.LanguageModelChat | undefined> {
  const models = await getAvailableModels();

  if (models.length === 0) {
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(
    models.map((model) => ({
      label: model.name,
      description: `${model.vendor} / ${model.family}`,
      detail: `Model ID: ${model.id}`,
      model,
    })),
    {
      title: "Select AI Code Mentor model",
      placeHolder: "Choose the language model to use",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  if (!selected) {
    return selectedModel;
  }

  selectedModel = selected.model;
  vscode.window.showInformationMessage(
    `AI Code Mentor will use ${selectedModel.name}.`,
  );

  return selectedModel;
}

async function getAvailableModels(): Promise<vscode.LanguageModelChat[]> {
  const models = await vscode.lm.selectChatModels();
  const excludedModels = vscode.workspace
    .getConfiguration("ai-code-mentor")
    .get<string[]>("excludedModels", []);

  // VS Code does not expose the Agent picker's "high cost" label or cost tier
  // through LanguageModelChat, so exclude the configured names or model IDs.
  return models.filter(
    (model) =>
      !excludedModels.some((excludedModel) => {
        const normalizedExcludedModel = excludedModel.toLowerCase();

        return (
          model.name.toLowerCase() === normalizedExcludedModel ||
          model.id.toLowerCase() === normalizedExcludedModel
        );
      }),
  );
}

function resetActivity(): void {
  changedCharacters = 0;
  changedFiles.clear();
}

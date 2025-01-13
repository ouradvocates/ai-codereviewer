import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface AIResponse {
  lineNumber: string;
  reviewComment: string;
  isGeneralComment?: boolean;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line?: number }>> {
  const comments: Array<{ body: string; path: string; line?: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `You are an expert code reviewer focusing on code quality, security, and best practices. Your task is to review the following pull request changes.

RESPONSE FORMAT:
You must respond with a JSON object in this exact format:
{
  "reviews": [
    {
      "lineNumber": <number or null>,
      "reviewComment": "<your detailed review comment>",
      "isGeneralComment": <boolean>
    }
  ]
}

REVIEW GUIDELINES:
1. Focus Areas:
   - Code quality and maintainability
   - Potential bugs or edge cases
   - Security vulnerabilities
   - Performance implications
   - Architecture and design patterns

2. Comment Types:
   - For issues tied to specific lines:
     * Set "lineNumber" to the line number
     * Set "isGeneralComment" to false
   - For broader architectural or design issues:
     * Omit "lineNumber" or set to null
     * Set "isGeneralComment" to true
     * Use only for significant issues that affect multiple lines or overall design

3. Writing Style:
   - Be concise but thorough
   - Use Markdown formatting for clarity
   - Explain both the problem and the recommended solution
   - Include examples when helpful
   - Be direct but constructive

4. Restrictions:
   - Never suggest adding code comments
   - Never provide positive feedback or compliments
   - For line-specific comments, only reference lines that start with + or -
   - Only raise issues that need improvement

CONTEXT:
File: ${file.to}
PR Title: ${prDetails.title}
PR Description:
---
${prDetails.description}
---

DIFF TO REVIEW:
\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`

Analyze the code changes and provide your review following the above guidelines.`;
}

async function getAIResponse(prompt: string): Promise<Array<AIResponse> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<AIResponse>
): Array<{ body: string; path: string; line?: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }

    // Handle general comments
    if (aiResponse.isGeneralComment) {
      return [{
        body: `**General comment for ${file.to}:**\n\n${aiResponse.reviewComment}`,
        path: file.to
      }];
    }

    // Convert lineNumber to number
    const lineNum = Number(aiResponse.lineNumber);

    // Verify the line number is within the current chunk
    const isLineInChunk = chunk.changes.some(
      (change) => 
        // Check both new and old line numbers using type assertion
        ((change as any).ln && (change as any).ln === lineNum) || 
        ((change as any).ln2 && (change as any).ln2 === lineNum)
    );

    if (!isLineInChunk) {
      console.log(`Warning: Line ${lineNum} is not part of the current diff chunk in ${file.to}`);
      return [];
    }

    return [{
      body: aiResponse.reviewComment,
      path: file.to,
      line: lineNum,
    }];
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line?: number }>
): Promise<void> {
  const lineComments = comments.filter((c): c is { body: string; path: string; line: number } => 
    c.line !== undefined
  );
  const generalComments = comments.filter(c => c.line === undefined);

  if (lineComments.length > 0) {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments: lineComments,
      event: "COMMENT",
    });
  }

  if (generalComments.length > 0) {
    const generalCommentsBody = generalComments
      .map(c => c.body)
      .join('\n\n---\n\n');

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      body: `# AI Code Review - General Comments\n\n${generalCommentsBody}`,
      event: "COMMENT",
    });
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

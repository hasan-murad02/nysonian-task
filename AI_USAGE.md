# AI Usage

This was built with Claude Code, directed the whole way through rather than left to run on its own.

## How this worked

Claude Code wrote the code, ran the commands, and reported back at each step. The direction, the decisions about what counted as good enough, and the call on what to check before moving on all happened along the way, not from one upfront brief that got executed blind.

The console UI got sent back twice. The first time with specific direction on fonts, colors, and how the components should be used. The second time because it still read as generic, which forced a real second pass on layout, hierarchy, and the small details that make a dashboard feel considered instead of default. Git stayed under deliberate control the whole time: nothing got pushed until it had been checked first, commits were scoped and staged on purpose, and specific files got held back from a commit while still under review rather than going out with everything else.

The verification approach was also a decision, not a default. Every stage got checked against real Postgres, Mongo, and Azure instead of mocks, with findings fixed and rechecked until nothing was left, and that loop kept going until it actually passed clean. Near the end, the whole project got checked directly against the original assessment PDF instead of against the internal build plan, since the plan is only a summary and the PDF is what actually counts. That check caught real gaps, including that DECISIONS.md and this file were not even pushed yet.

## Per stage

The database and client setup used Neon's HTTP driver instead of a pooled connection, and cached the Mongo client, both decided up front to avoid known serverless connection problems rather than found by hitting them later.

The ingest logic and workflow state machine, including the guarded update pattern and the row lock that prevents over refunds, are the part most likely to hide a subtle concurrency bug that would not show up without a real race. That is why this part got the most live concurrent testing rather than being trusted on a read of the code.

The policy documents, the retrieval filter, and the decision prompt and schema got checked for real with the retrieval eval, not assumed correct because they looked reasonable.

The console UI had a real stale data race in the detail dialog, found through testing with an injected network delay, fixed, and confirmed fixed by reproducing it again afterward. Full story is in DECISIONS.md.

The eval script and the replay verification tooling got run against real Postgres, Mongo, and Azure, both locally and against the deployed Vercel URL, not just written and assumed to work.

The dark mode toggle and the retrieval test tab came after the rest of the console already existed. The toggle hit the same kind of effect and state timing issue the console UI hit earlier, and got fixed the same way on purpose, using the lesson already learned instead of repeating the mistake. The retrieval test tab calls the real retrieval function directly through a new API route rather than a second version written just for the UI, checked live by clicking through the suggested questions and confirming the scores matched the committed eval numbers.

This documentation was written from what is actually in the repo and in the committed eval reports, not from a general description of what the build was supposed to do.

## A case of the model being confidently wrong

While checking the replay verification stage, the AI was asked to follow a checklist that was already available to it from earlier in the session. Instead it tried to call a tool to invoke that checklist as a skill. The tool call was refused, since that skill can only be triggered directly by a user command.

It then concluded the task was impossible and stopped, having done no actual work, and reported back that it was blocked. This was wrong. Nothing stopped it from just reading and following the checklist that was already in front of it.

The fix was pointing out that failing to call one specific tool is not the same as being unable to do the task, then asking it to try again with that in mind. It then completed the check normally, including live testing part of the system itself.

The lesson is that a model saying it is blocked is a claim, not a fact, and it is worth checking, especially when the same system reporting the block is also the one that would otherwise have to do the work.

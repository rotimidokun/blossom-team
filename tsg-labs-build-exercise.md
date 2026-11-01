# **TSG Labs Build Exercise**

Oct 19, 2026

## **Why this exercise**

Chord is TSG Labs' platform for building AI teammates. Each teammate is made of four parts: skills (written as files that hold the logic), tools (connections to a business's own systems and APIs), a model, and a channel such as WhatsApp.

We're hiring for several roles at TSG Labs across engineering, product and growth, and we use this one exercise for all of them.  Chord is the shared platform everyone builds on, because each of these roles needs someone who can find a real problem, connect to real systems, ship something, and explain what broke along the way. We want to see how you integrate, how creative you are with what Chord can do, and how clearly you report what got in your way.

When Shola put out the call, he asked for people who can talk to customers, prototype solutions, build the integrations, and get them into production. This exercise asks you to do all four, in miniature.

It's meant to be light. Plan for about 6 hours of focused work. A small agent that works end to end, with honest notes, beats an ambitious one that only half runs.

## **The brief**

Choose a real business and a problem worth solving, then build a Chord agent that does one useful job for it from start to finish, on WhatsApp. Your agent must be built and run on Chord, and must include:

1. At least one skill you write yourself, with enough context about the business that the agent behaves like it works there.
2. At least one custom tool that calls an external system: Paystack in test mode, a public API, a Google Sheet, or a small mock API you build and host yourself.
3. A full conversation that we can run in the WhatsApp simulator, where the agent takes a real action through your tool rather than only answering questions.

There's no set scenario: picking the problem is part of the exercise. If you're stuck, think of a business you know that runs on WhatsApp and loses time or money on something repetitive.

We care more about the quality of your choices than the size of the build.

## **What you get and how long you have**

To start, sign up for your own Chord account and send your TSG Labs contact the email address you used. We'll add up to 50 credits for the exercise and give you access to the WhatsApp simulator, so you can test your agent without a real phone number.

You have 5 days from when your access arrives. We expect about 6 hours of work in total, and you can spread it however you like. If your credits run out or something on our side blocks you, tell us straight away. How you handle that is part of what we're looking at.

## **What to submit**

Send us six things:

1. **Your role preference and problem statement.** At the top of your submission, name the role or roles you want, then write three or four sentences covering who the business is, what problem your agent solves for them, why that problem is worth paying for, and what you deliberately left out.
2. **The working agent.** Leave it live on your Chord account so we can talk to it in the simulator ourselves.
3. **Your code.** A repo with your skill files and tool code, plus a short README explaining how to run it.
4. **A 3-minute screen recording.** Walk us through one full conversation and show the moment your tool does its job.
5. **Deployment field notes.** This is the most important part. For each problem you hit while building or deploying, tell us:
- what happened, including any error messages;
- how you worked out the cause;
- how you fixed it or worked around it;
- what you'd change in Chord, its docs or its API so the next builder doesn't hit the same thing.
1. **A go-live note for the business, half a page at most.** Imagine you're handing this agent to the business owner. Explain what it does, what it doesn't do, and what would need to be true before it went live for real customers. That might include live API keys, a phone number connected to WhatsApp, what happens when a payment fails, and who gets alerted when something breaks.

The field notes are where we learn the most about you. Short, specific notes about two or three real problems are worth more than a long list.

## **How we assess**

We score each area from 1 to 5, then weight them.

| Area | Weight | What a 5 looks like |
| --- | --- | --- |
| Integration | 25% | The tool calls a real system, the action actually happens, and errors such as a failed payment or an empty response are handled rather than ignored |
| Deployment field notes | 25% | Specific problems, a clear account of how each cause was found, and product feedback the Chord team could act on next week |
| Creativity and problem choice | 20% | A problem a real business would pay to solve, with a smart use of Chord that we hadn't thought of |
| Customer thinking | 15% | A go-live note a non-technical owner could follow, with honest limits and real go-live risks |
| Communication | 15% | A clear recording and README, and concise writing that respects the reader's time |

Those weights are the default. We shift them depending on the role you name:

| Role | What we weight most |
| --- | --- |
| Forward-deployed Engineering | Integration and deployment field notes |
| Technical Product Management | Integration with payment or merchant systems, and the go-live note |
| Growth | Problem choice with a measurable growth outcome, such as users activated or conversion |
| Product Management | Problem choice and customer thinking |

We'll invite the strongest submissions to a 45-minute session where you demo your agent live and we change the requirements on the spot, the way a customer would.

## **Ground rules**

- **Use any AI tools you like.** In your README, tell us briefly how you used them. However the agent itself must be built and run on Chord.
- **Use test keys and made-up data only.** Don't connect real customer data, live payment keys or anyone's personal number.
- **It’s fine not to build every feature you planned.** Submit a working demo that shows what you had in mind, along with a note covering what stopped you, what you tried to get past it, and what you’d have built with more time or resources.
- **Ask questions.** Your TSG Labs contact is named in your invite email. Asking a good question early is something we look for, not something we mark you down for.
- **Keep it to yourself.** Please don't share your access or this brief with anyone else, and use your credits only for this exercise.

**Resource Library**

- **Context**: Introducing TSG Labs, Shola’s post on why TSG Labs exists and what it’s building, starting with AI and stablecoins.
- **Chord**: Create a Chord account, then send your TSG Labs contact the email you used so we can add your credits.
- **Chord API Documentation**: api.chordhq.xyz/docs, the API reference for building and managing teammates, skills and tools.
- **WhatsApp Simulator**: https://chat.tsglabs.dev/, for testing your agent end to end without a real phone number.
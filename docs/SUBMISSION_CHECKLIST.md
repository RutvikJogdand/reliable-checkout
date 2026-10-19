# Before submitting

The backend, tests and documents are prepared. These steps depend on your own
environment, review and repository account:

1. Run `npm ci`, `npm test`, `npm run demo` and `npm start` with Node.js 24.
2. Create a cart, purchase it, retry the checkout key and inspect the report.
3. Trace checkout and explain how the transaction protects stock and coupons.
4. Reproduce the automatic-rollback correction using its focused test, then
   restore the correct code.
5. Make one intentional change you understand, add an appropriate test and
   update its API/decision documentation.
6. Review the decisions and AI disclosure so they reflect what you can defend.
   Record actual total time, including your study/review, within the timebox.
7. Configure your Git identity for your own review/change commits. The included
   history already records the implementation under an AI-assisted identity.
8. Create an empty repository under your account, public or accessible to the
   evaluator. Push and verify source, tests, docs and history are visible.

After creating the remote repository, run from the project directory:

```sh
git status
git log --oneline
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

Replace `YOUR_REPOSITORY_URL` with the actual URL. No remote is configured in the
delivered project. If one exists by then, inspect `git remote -v` before changing
it. Avoid force pushes. Local database and environment files are already ignored.

The initial implementation-session time is recorded in README. Your independent
review, final total time and repository publication remain to be completed.

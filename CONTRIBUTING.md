# Contributing to FINOS projects

FINOS projects are [Apache 2.0 licensed](LICENSE) and accept contributions via git pull requests.

## Developer Certificate of Origin (DCO)

All contributions to this project must be accompanied by a **Developer Certificate of Origin** sign-off. This is a FINOS requirement that certifies you have the right to submit the contribution under the project's license.

> [!IMPORTANT]
> Every commit in the pull request must contain a `Signed-off-by` line. The DCO check fails if any commit is missing it.

This sign-off means you agree the commit satisfies the [Developer Certificate of Origin (DCO)](https://developercertificate.org/).

> Pull requests that contain a commit without a `Signed-off-by` line will not be merged.

The commit message must contain a line like this, with your name and email:

```
Signed-off-by: John Doe <john.doe@example.com>
```

The name and email must match the commit author. Use an email address that is on your GitHub account. To keep your address private, set Git to the `noreply` address shown at [github.com/settings/emails](https://github.com/settings/emails). It looks like `ID+username@users.noreply.github.com`. Use that same address in the sign-off. See [Setting your commit email address](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address).

### Configuring Git to sign off

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

Add the trailer on each commit:

```bash
git commit -s -m "your message"
```

`git commit -s` inserts the line from `user.name` and `user.email`. You can also type it into the message yourself, or add it to the latest commit with `git commit --amend -s`.

Git has no setting that adds this line to every `git commit`. `format.signoff` only affects `git format-patch`. An alias keeps the sign-off explicit:

```bash
git config --global alias.ci "commit -s"
git ci -m "your message"
```

### How to fix a failing DCO check

Leave the pull request open. Add the missing sign-off, then update the branch.

For the latest commit only:

```bash
git commit --amend -s --no-edit
git push --force-with-lease
```

For every commit on the branch that is not in the pull request's base:

```bash
git fetch origin
git rebase --signoff origin/main
git push --force-with-lease
```

Replace `origin` with the remote that has the base branch, and replace `main` if the base branch has another name. `--signoff` writes your current `user.name` and `user.email`, so those values must match the author of the commits you are rewriting. This rewrites the commits. Run it on your own pull-request branch.

### Helpful DCO resources

- [Developer Certificate of Origin](https://developercertificate.org/)
- [`git commit --signoff`](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---signoff)
- [DCO GitHub App](https://github.com/apps/dco)
- [Setting your commit email address](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)

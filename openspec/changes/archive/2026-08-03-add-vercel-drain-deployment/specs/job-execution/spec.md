## Purpose

How queued work gets executed, independent of where the product is deployed. These rules hold
whether jobs are run by a resident process or by a timer-driven endpoint, so that a deployment
without long-lived processes is a hosting decision rather than a behavioural compromise.

## ADDED Requirements

### Requirement: Execution mechanisms are interchangeable

The system SHALL support executing queued work either as a resident process or as an
externally-triggered bounded pass, and the two SHALL be behaviourally equivalent. Every job type
SHALL be executable by both. Neither mechanism SHALL be required for correctness of the other.

#### Scenario: The same job runs under either mechanism

- **WHEN** a job of any type is executed by a resident process, and an identical job is executed by
  a bounded pass
- **THEN** both produce the same stored result and the same follow-on jobs

#### Scenario: A deployment runs only bounded passes

- **WHEN** a deployment has no resident process and is driven only by an external timer
- **THEN** every category of queued work is still executed, including work no user action triggers

#### Scenario: Both mechanisms run at once

- **WHEN** a resident process and a bounded pass execute against the same queue simultaneously
- **THEN** no job is executed by both, and neither observes an error from the other's activity

### Requirement: A job has at most one executor at a time

The system SHALL ensure a pending job is claimed by at most one executor. Claiming SHALL be safe
under concurrency without external coordination, and adding executors SHALL NOT require
reconfiguring existing ones.

#### Scenario: Two executors claim simultaneously

- **WHEN** two executors request work at the same instant and one runnable job exists
- **THEN** exactly one receives it and the other receives nothing or a different job

#### Scenario: Executors are added

- **WHEN** a second executor starts against a queue an existing executor is already draining
- **THEN** throughput increases and no job is duplicated

### Requirement: Work whose executor vanished is recovered

The system SHALL return to the runnable pool any job whose executor stopped without recording an
outcome, after a bounded period. Recovery SHALL NOT reset the job's attempt count, so a job that
repeatedly kills its executor still exhausts its retry budget rather than looping forever.

This applies to every execution mechanism. An unrecovered job is worse than a failed one: because a
deduplication key collides while a job is pending **or** running, a job stuck in the running state
also suppresses every subsequent enqueue that shares its key, silently stopping future work for
that subject with no error recorded anywhere.

#### Scenario: An executor is killed mid-job

- **WHEN** an executor is terminated while holding a claimed job
- **THEN** the job becomes runnable again after the recovery period and is executed
- **AND** its attempt count reflects the killed attempt

#### Scenario: A bounded pass is terminated by its host

- **WHEN** a bounded pass is stopped by its platform before recording an outcome for the job it held
- **THEN** that job is recovered by a later pass without operator intervention

#### Scenario: A subject's later work is not suppressed

- **WHEN** a job carrying a deduplication key is left in the running state by a vanished executor
- **THEN** after recovery, work for that subject can be enqueued and executed again

### Requirement: Due scheduled work is enqueued regardless of mechanism

The system SHALL evaluate scheduled tasks and enqueue their work when due, under every execution
mechanism. A deployment SHALL NOT be able to serve user-triggered work while silently never running
scheduled work.

Firing SHALL be claimed such that two concurrent evaluations cannot both fire one occurrence, and
evaluating more often than a task's interval SHALL enqueue nothing extra.

#### Scenario: Periodic sync under a bounded-pass deployment

- **WHEN** a deployment executes only bounded passes and a scheduled sync interval elapses
- **THEN** the periodic sync work is enqueued and subsequently executed, with no user action

#### Scenario: Evaluation is more frequent than the interval

- **WHEN** scheduled tasks are evaluated several times within one task's interval
- **THEN** the task fires at most once for that interval

#### Scenario: Two evaluations coincide

- **WHEN** two executors evaluate the same due task simultaneously
- **THEN** exactly one fires it and the task's next occurrence advances once

#### Scenario: An occurrence is missed

- **WHEN** no executor runs for longer than a task's interval
- **THEN** the task fires on the next evaluation and no enqueued work is lost

### Requirement: Work is enqueued atomically with the data that justifies it

The system SHALL commit a job together with the data that requires it, so no state can exist for
which its follow-on work was lost. The queue SHALL therefore remain in the same transactional store
as the data it refers to.

#### Scenario: Ingestion is followed by analysis

- **WHEN** normalized records are written and their analysis work is enqueued
- **THEN** either both are committed or neither is

#### Scenario: The commit fails

- **WHEN** the write that justifies a job fails after the job was enqueued in the same transaction
- **THEN** the job does not exist to be executed

### Requirement: Bounded execution yields rather than being killed

The system SHALL allow an execution pass to be given a time budget, and the pass SHALL stop
claiming new work in time to finish what it holds and report an outcome within that budget.
Stopping SHALL be indistinguishable, in stored state, from a pass that ran out of work.

#### Scenario: The budget is reached with work remaining

- **WHEN** a pass exhausts its budget while runnable jobs remain
- **THEN** it stops claiming, completes or releases the job it holds, and returns
- **AND** the remaining jobs are runnable by the next pass

#### Scenario: A graceful stop is signalled

- **WHEN** an executor is asked to stop by its host
- **THEN** it finishes the job in progress and exits without abandoning it

### Requirement: An execution trigger is authenticated and reports its outcome

Where execution is triggered over the network, the trigger SHALL be authenticated by a shared
secret and SHALL NOT be reachable by an unauthenticated caller. It SHALL act on behalf of no user
and SHALL NOT be governed by workspace access rules, so it SHALL NOT accept a workspace, repository,
or any other caller-supplied selector that would let it be used to act on a chosen target.

Each invocation SHALL report what it did — at least the number of jobs claimed, succeeded, retried,
and failed, and the number of scheduled tasks fired — so that a trigger which is running but
achieving nothing is distinguishable from one that is not running.

#### Scenario: An unauthenticated request arrives

- **WHEN** the execution trigger is called without valid credentials
- **THEN** no job is claimed and the request is refused

#### Scenario: A caller supplies a target

- **WHEN** the execution trigger is called with a workspace or job selector in its request
- **THEN** the selector has no effect on which work is executed

#### Scenario: A pass finds nothing to do

- **WHEN** the trigger runs against an empty queue
- **THEN** it reports zero counts rather than failing

#### Scenario: A pass is running but wedged

- **WHEN** every pass reports zero jobs claimed while queue depth is non-zero
- **THEN** the reported counts make that state visible without inspecting the database

### Requirement: Failure handling is uniform across mechanisms

The system SHALL apply the same retry, backoff, and terminal-failure rules however a job is
executed. A retryable failure SHALL become runnable again after a backoff; a failure that cannot be
resolved by waiting SHALL become terminal without consuming further attempts; and credentials
rejected by the upstream provider SHALL be handled as an installation-level problem rather than
consuming a job's retry budget.

#### Scenario: A transient failure under a bounded pass

- **WHEN** a job fails transiently during a bounded pass
- **THEN** it becomes runnable again after the same backoff a resident process would apply

#### Scenario: Backoff outlives the pass that set it

- **WHEN** a job's backoff extends beyond the pass that failed it
- **THEN** a later pass executes it once the backoff has elapsed

#### Scenario: Retries are exhausted

- **WHEN** a job reaches its attempt limit under either mechanism
- **THEN** it is recorded as failed with its last error and stops being claimed

export {
  API_ERRORS,
  BadGateway,
  BadRequest,
  Conflict,
  ConfigError,
  DEFAULT_ERRORS,
  Forbidden,
  GatewayTimeout,
  HTTP_STATUS_MAP,
  InternalServerError,
  Locked,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
} from "@distilled.cloud/core/errors";
export type { DefaultErrors } from "@distilled.cloud/core/errors";

import * as Category from "@distilled.cloud/core/category";
import * as Schema from "@distilled.cloud/core/schema-lite-typed";
import { applyErrorMatchers } from "@distilled.cloud/core/trait";

export const PolicyFileFinding = Schema.Struct({
  user: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.String)),
  warnings: Schema.optional(Schema.Array(Schema.String)),
});
export type PolicyFileFinding = typeof PolicyFileFinding.Type;

export class PolicyFileRejected extends Schema.TaggedError<PolicyFileRejected>()(
  "PolicyFileRejected",
  {
    message: Schema.String,
    body: Schema.optional(
      Schema.Struct({
        message: Schema.String,
        data: Schema.optional(Schema.NullOr(Schema.Array(PolicyFileFinding))),
      }),
    ),
  },
).pipe(Category.withBadRequestError) {}
applyErrorMatchers(PolicyFileRejected, [{ status: 400 }]);

export class UnknownTailscaleError extends Schema.TaggedError<UnknownTailscaleError>()(
  "UnknownTailscaleError",
  {
    code: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    body: Schema.Unknown,
  },
).pipe(Category.withServerError) {}

export class TailscaleParseError extends Schema.TaggedError<TailscaleParseError>()(
  "TailscaleParseError",
  {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  },
).pipe(Category.withParseError) {}

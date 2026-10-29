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
import * as Category from "@distilled.cloud/core/category";
import type { DefaultErrors as CoreDefaultErrors } from "@distilled.cloud/core/errors";
import * as Schema from "@distilled.cloud/core/schema-lite-typed";

/**
 * A failed response whose HTTP status has no mapped error class. `code` is
 * the Connect error code (`not_found`, `permission_denied`, ...).
 */
export class UnknownNamespaceLabsError
  extends /*@__PURE__*/ Schema.TaggedError<UnknownNamespaceLabsError>()(
    "UnknownNamespaceLabsError",
    {
      code: /*@__PURE__*/ Schema.optional(Schema.String),
      message: /*@__PURE__*/ Schema.optional(Schema.String),
      body: Schema.Unknown,
    },
  ).pipe(Category.withServerError) {}

export class NamespaceLabsParseError
  extends /*@__PURE__*/ Schema.TaggedError<NamespaceLabsParseError>()("NamespaceLabsParseError", {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  }).pipe(Category.withParseError) {}

export type ClientErrors = UnknownNamespaceLabsError | NamespaceLabsParseError;

export type DefaultErrors = CoreDefaultErrors | ClientErrors;

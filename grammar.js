/**
 * @file Kulala HTTP Parser
 * @author Yaro Apletov <yaro@dream-it.es>
 * @author Marco Kellershoff <marco@the-dont-be-evil-company.com>
 * @license MIT
 */

/// <reference types="./node_modules/tree-sitter-cli/dsl.d.ts" />
// @ts-check

const PREC = {
  // Above body tokens so `#` / `//` lines prefer comment over raw_body / json / graphql.
  // Below REQ_SEPARATOR so `###` still opens a section.
  COMMENT_PREFIX: 5,
  VAR_COMMENT_PREFIX: 2,
  BODY_PREFIX: 2,
  RAW_BODY: 3,
  GRAPHQL_JSON_PREFIX: 4,
  REQ_SEPARATOR: 9,
};

const WORD_CHAR = /[\p{L}\p{N}]/u;
const PUNCTUATION = /[^\n\r\p{Z}\p{L}\p{N}]/u;
const WS = /\p{Zs}+/u;
const NL = token(choice("\n", "\r", "\r\n", "\0"));
const LINE_TAIL = token(seq(/.*/, NL));
const ESCAPED = token(/\\[^\n\r]/);
// Only horizontal whitespace - `\s` would swallow newlines and merge comment lines.
const COMMENT_PREFIX = token(
  prec(PREC.COMMENT_PREFIX, choice(/#[ \t]*/, /\/\/[ \t]*/)),
);

const OPTIONAL_WS = optional(WS);
const OPTIONAL_TOKEN_WS = optional(token(prec(1, WS)));

const SPACES_TABS = /[ \t]+/;
const PARAM_VALUE_CHARS = /[^\n\r&#\s]+/;
const FORM_PARAM_NAME_CHARS = /[a-zA-Z0-9_@.\[\]]/;
const FORM_PARAM_EXCLUSIONS = /[^\s\n\r=&#<{\[\]\}\-:,]+/;

// Quoted text stays one anonymous token so the JSON/GraphQL injection still sees a string.
// Prec 4 is above raw body (3) and below comments (5).
const BODY_STRING = token(prec(4, /"([^"\\\n]|\\.)*"/));
const BODY_BLOCK_STRING = token(prec(4, /"""([^"]|"[^"]|""[^"])*"""/));
// Stops before `"`, `{`, `}`, and newlines so `{{ }}` and JSON structure stay separate tokens.
const JSON_CHUNK = token(prec(PREC.RAW_BODY, /[^"{}\n]+/));
// Above the json/graphql body prefix so a nested `{` stays inside the open body.
// Same precedence as `{{` / `}}`; the longer interpolation token wins.
const JSON_OPEN = token(prec(PREC.COMMENT_PREFIX, "{"));
const JSON_CLOSE = token(prec(PREC.COMMENT_PREFIX, "}"));
const BODY_NL = token(prec(PREC.RAW_BODY, /\r?\n|\r/));
// A GraphQL operation line. Single `{` stays inside the line so it does not open the
// variables object. `{{` does not match, so interpolations can be split out.
// A `{` at column 0 still loses to graphql_json_body (prec 4 > 3).
const GQL_LINE = token(
  prec(PREC.RAW_BODY, /(?:[^"{\n]|\{[^\n"{])*(?:\{\r?\n|\r?\n)/),
);
const GQL_CHUNK = token(prec(PREC.RAW_BODY, /[^"{\n]+/));
const GQL_NAME = token(
  prec(
    2,
    /[A-Za-z_.$\d\u00A1-\uFFFF-]+(\[[^\]]+\]|\.[A-Za-z_.$\d\u00A1-\uFFFF-]+|\([^)]*\))*/,
  ),
);

module.exports = grammar({
  name: "kulala_http",

  extras: (_) => [],
  conflicts: ($) => [[$.target_url], [$._section_content], [$.value]],
  inline: ($) => [$._target_url_line, $.__body],

  rules: {
    document: ($) => repeat($.section),

    comment: (_) => seq(COMMENT_PREFIX, LINE_TAIL),

    metadata: ($) =>
      prec(
        3,
        seq(
          COMMENT_PREFIX,
          token(prec(PREC.VAR_COMMENT_PREFIX, "@")),
          field("name", $.identifier),
          optional(
            choice(
              prec.left(3, seq("=", OPTIONAL_WS, field("value", $.value))),
              prec.left(2, seq(WS, "=", OPTIONAL_WS, field("value", $.value))),
              prec.left(1, seq(WS, field("value", $.value))),
              prec.right(WS),
            ),
          ),
          NL,
        ),
      ),

    request_separator: ($) =>
      seq(
        token(prec(PREC.REQ_SEPARATOR, /###+\p{Zs}*/)),
        optional(token(prec(1, WS))),
        optional(field("value", $.value)),
        NL,
      ),

    section: ($) =>
      prec.right(
        choice(
          seq($.request_separator, optional($._section_content)),
          $._section_content,
        ),
      ),

    _section_content: ($) =>
      choice(
        seq($._blank_line, optional($._section_content)),
        seq($.comment, optional($._section_content)),
        seq($.metadata, optional($._section_content)),
        seq($.variable_declaration, optional($._section_content)),
        seq($.command, optional($._section_content)),
        seq($.pre_request_script, optional($._section_content)),
        field("request", $.request),
        field("response", $.response),
      ),

    method: (_) =>
      /(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT|PATCH|LIST|GRAPHQL|GRPC|WEBSOCKET|WS|WSS)/,

    http_version: (_) => prec.dynamic(1, token(prec(0, /HTTP\/[\d\.]+/))),

    _target_url_line: ($) =>
      repeat1(
        choice(
          $.query_string,
          $.query_param_continuation,
          $.fragment,
          $.variable,
          WORD_CHAR,
          PUNCTUATION,
          WS,
        ),
      ),
    target_url: ($) =>
      seq($._target_url_line, repeat(seq(NL, WS, $._target_url_line))),

    query_string: ($) =>
      seq(
        alias("?", $.operator),
        field("params", $.query_param),
      ),

    query_param_continuation: ($) =>
      seq(
        alias("&", $.operator),
        field("params", $.query_param),
      ),

    query_param: ($) =>
      prec.right(
        seq(
          field("name", $.query_param_name),
          optional(
            seq(
              alias("=", $.operator),
              optional(field("value", $.query_param_value)),
            ),
          ),
        ),
      ),

    query_param_name: ($) =>
      prec.right(
        choice(
          $.variable,
          seq(
            token(/[^\s\n\r=&#]+/),
            repeat(
              choice(
                $.variable,
                token(/[^\s\n\r=&#]+/),
                token(prec(1, seq(/\s+/, /[^\s\n\r=&#H]/))),
                token(prec(1, seq(/\s+/, /H[^T]/))),
                token(prec(1, seq(/\s+/, /HT[^T]/))),
                token(prec(1, seq(/\s+/, /HTT[^P]/))),
                token(prec(1, seq(/\s+/, /HTTP[^\/]/))),
              ),
            ),
          ),
        ),
      ),

    query_param_value: ($) =>
      prec.right(
        choice(
          $.variable,
          seq(
            token.immediate(/[^\n\r&#\s]+/),
            repeat(
              choice(
                $.variable,
                token(/[^\n\r&#\s]+/),
                token(prec(2, seq(SPACES_TABS, /[^\n\r&#\sH]/))),
                token(prec(2, seq(SPACES_TABS, /H[^T]/))),
                token(prec(2, seq(SPACES_TABS, /HT[^T]/))),
                token(prec(2, seq(SPACES_TABS, /HTT[^P]/))),
                token(prec(2, seq(SPACES_TABS, /HTTP[^\/]/))),
              ),
            ),
          ),
        ),
      ),

    fragment: ($) =>
      seq(alias("#", $.operator), optional(token(prec(1, /[^\s\n\r]+/)))),

    status_code: (_) => /[1-5]\d{2}/,
    status_text: (_) =>
      /(Continue|Switching Protocols|Processing|OK|Created|Accepted|Non-Authoritative Information|No Content|Reset Content|Partial Content|Multi-Status|Already Reported|IM Used|Multiple Choices|Moved Permanently|Found|See Other|Not Modified|Use Proxy|Switch Proxy|Temporary Redirect|Permanent Redirect|Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Method Not Allowed|Not Acceptable|Proxy Authentication Required|Request Timeout|Conflict|Gone|Length Required|Precondition Failed|Payload Too Large|URI Too Long|Unsupported Media Type|Range Not Satisfiable|Expectation Failed|I'm a teapot|Misdirected Request|Unprocessable Entity|Locked|Failed Dependency|Too Early|Upgrade Required|Precondition Required|Too Many Requests|Request Header Fields Too Large|Unavailable For Legal Reasons|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout|HTTP Version Not Supported|Variant Also Negotiates|Insufficient Storage|Loop Detected|Not Extended|Network Authentication Required)/,

    __body: ($) =>
      seq(
        repeat1($._blank_line),
        prec.right(
          repeat(
            choice(
              alias($.metadata, $.comment),
              $.comment,
              field(
                "body",
                choice(
                  $.multipart_form_data,
                  $.xml_body,
                  $.json_body,
                  $.graphql_body,
                  $.form_urlencoded_body,
                  $._external_body,
                  $.raw_body,
                ),
              ),
              NL,
              $.res_handler_script,
              $.res_redirect,
            ),
          ),
        ),
      ),

    response: ($) =>
      prec.right(
        seq(
          $.http_version,
          WS,
          $.status_code,
          WS,
          optional($.status_text),
          NL,
          repeat(field("header", $.header)),
          optional($.__body),
        ),
      ),

    request: ($) =>
      prec.right(
        seq(
          optional(seq(field("method", $.method), WS)),
          field("url", $.target_url),
          optional(seq(WS, field("version", $.http_version))),
          NL,
          repeat(choice($.comment, field("header", $.header))),
          optional($.__body),
        ),
      ),

    header: ($) =>
      seq(
        field("name", $.header_entity),
        OPTIONAL_WS,
        ":",
        OPTIONAL_TOKEN_WS,
        optional(field("value", $.value)),
        NL,
      ),

    // {{foo}} {{$bar}} {{ fizzbuzz }}
    variable: ($) =>
      seq(
        token(prec(PREC.COMMENT_PREFIX, "{{")),
        OPTIONAL_WS,
        field("name", $.identifier),
        OPTIONAL_WS,
        token(prec(PREC.COMMENT_PREFIX, "}}")),
      ),

    pre_request_script: ($) =>
      seq("<", WS, choice($.script, $.path), token(repeat1(NL))),
    res_handler_script: ($) =>
      seq(
        token(prec(PREC.REQ_SEPARATOR, ">")),
        WS,
        choice($.script, $.path),
        token(repeat1(NL)),
      ),
    script: ($) =>
      seq(
        token(prec(1, "{%")),
        choice(
          seq(field("lang", $.script_lang), field("body", $.script_body)),
          seq(NL, field("body", $.script_body)),
        ),
        token(prec(1, "%}")),
      ),
    script_lang: (_) => seq(WS, token(prec(1, /lang=js/)), NL),
    script_body: (_) => repeat1(LINE_TAIL),

    res_redirect: ($) =>
      seq(
        token(prec(PREC.REQ_SEPARATOR, />>!?/)),
        WS,
        field("path", $.path),
        token(repeat1(NL)),
      ),

    variable_declaration: ($) =>
      seq(
        "@",
        field("name", $.identifier),
        OPTIONAL_WS,
        "=",
        OPTIONAL_TOKEN_WS,
        field("value", $.value),
        NL,
      ),

    variable_declaration_inline: ($) =>
      seq(
        "@",
        field("name", $.identifier),
        OPTIONAL_WS,
        "=",
        OPTIONAL_TOKEN_WS,
        field("value", $.value),
      ),

    command: ($) =>
      seq(
        field("name", alias(choice("run", "import"), $.command_name)),
        WS,
        field("value", prec.left($.value)),
        optional(
          seq(
            OPTIONAL_WS,
            "(",
            OPTIONAL_WS,
            optional(
              seq(
                field("variable", $.variable_declaration_inline),
                repeat(
                  seq(
                    OPTIONAL_WS,
                    ",",
                    OPTIONAL_WS,
                    field("variable", $.variable_declaration_inline),
                  ),
                ),
              ),
            ),
            OPTIONAL_WS,
            ")",
          ),
        ),
        NL,
      ),

    xml_body: ($) => seq(token(prec(PREC.BODY_PREFIX, /<[^\s@]/)), $._raw_body),

    json_body: ($) =>
      prec.right(
        seq(
          token(prec(PREC.BODY_PREFIX, /[{\[]\s*/)),
          repeat($._json_piece),
        ),
      ),

    // Hidden. `variable` is the only named child, so injections omit `{{ name }}`.
    _json_piece: ($) =>
      choice($.variable, BODY_STRING, JSON_CHUNK, JSON_OPEN, JSON_CLOSE, BODY_NL),

    graphql_body: ($) =>
      prec.right(
        seq(
          $.graphql_data,
          optional(alias($.graphql_json_body, $.json_body)),
          optional(alias($.graphql_external_body, $.external_body)),
        ),
      ),
    graphql_data: ($) =>
      prec.right(
        seq(
          token(
            prec(
              PREC.BODY_PREFIX,
              seq(
                choice("query", "mutation"),
                WS,
                /[^\n]*(\n[^\n{(]*)*[\{\(]\s*/,
                NL,
              ),
            ),
          ),
          repeat($._graphql_piece),
        ),
      ),
    // Hidden. Named children are only the delimiters, so the injected GraphQL
    // text keeps the name (`id: ITEM_ID`) and drops `{{` / `}}`.
    _graphql_piece: ($) =>
      choice(
        $._gql_interpolation,
        BODY_BLOCK_STRING,
        BODY_STRING,
        GQL_LINE,
        GQL_CHUNK,
        BODY_NL,
      ),
    _gql_interpolation: ($) =>
      seq(
        alias(token(prec(6, "{{")), $.interpolation_open),
        optional(token(prec(2, WS))),
        GQL_NAME,
        optional(token(prec(2, WS))),
        alias(token(prec(6, "}}")), $.interpolation_close),
      ),
    graphql_json_body: ($) =>
      prec.right(
        seq(
          token(prec(PREC.GRAPHQL_JSON_PREFIX, /[{\[]\s*/)),
          repeat($._json_piece),
        ),
      ),

    graphql_external_body: ($) =>
      seq(
        token(prec(PREC.GRAPHQL_JSON_PREFIX, "<")),
        WS,
        field("path", $.path),
        NL,
      ),

    _external_body: ($) => seq($.external_body, NL),
    external_body: ($) =>
      seq(token(prec(PREC.BODY_PREFIX, "<")), WS, field("path", $.path)),

    multipart_form_data: ($) =>
      prec.right(
        seq(
          $.multipart_boundary_first,
          repeat(
            choice(
              $.multipart_boundary,
              $.multipart_external_body,
              $.header,
              $.multipart_content_line,
              NL,
            ),
          ),
          $.multipart_boundary_last,
        ),
      ),

    multipart_content_line: (_) => seq(/[^\n\r-]+/, NL),

    multipart_external_body: ($) =>
      seq(
        token(prec(PREC.BODY_PREFIX + 1, "<")),
        WS,
        field("path", $.path),
        NL,
      ),

    multipart_boundary_first: ($) =>
      seq(
        token(prec(PREC.BODY_PREFIX, /--/)),
        alias($._boundary_value, $.boundary_value),
        NL,
      ),

    multipart_boundary: ($) =>
      seq(
        token(prec(PREC.BODY_PREFIX, /--/)),
        alias($._boundary_value, $.boundary_value),
        NL,
      ),

    multipart_boundary_last: ($) =>
      prec.dynamic(
        3,
        seq(
          token(prec(PREC.BODY_PREFIX, /--/)),
          alias($._boundary_value, $.boundary_value),
          token(prec(100, /--[\t \n\r]/)),
        ),
      ),

    _boundary_value: ($) =>
      prec.right(10, repeat1(choice($.variable, token(prec(1, /[^\s\n\r{]/))))),

    form_urlencoded_body: ($) =>
      prec.right(
        seq(
          field("params", alias($._form_param_first, $.form_param)),
          repeat(
            seq(
              alias("&", $.operator),
              optional(NL),
              field("params", $.form_param),
            ),
          ),
          NL,
        ),
      ),

    _form_param_first: ($) =>
      seq(
        field(
          "name",
          alias(
            token(
              prec(
                1,
                seq(
                  FORM_PARAM_EXCLUSIONS,
                  repeat(seq(/\s+/, FORM_PARAM_EXCLUSIONS)),
                ),
              ),
            ),
            $.form_param_name,
          ),
        ),
        alias("=", $.operator),
        optional(field("value", $.form_param_value)),
      ),

    form_param: ($) =>
      prec.right(
        seq(
          field("name", $.form_param_name),
          optional(
            seq(
              alias("=", $.operator),
              optional(field("value", $.form_param_value)),
            ),
          ),
        ),
      ),

    form_param_name: ($) =>
      prec.right(
        seq(
          choice($.variable, token(FORM_PARAM_NAME_CHARS)),
          repeat(
            choice(
              $.variable,
              token(FORM_PARAM_NAME_CHARS),
              token(prec(1, seq(/\s+/, FORM_PARAM_NAME_CHARS))),
            ),
          ),
        ),
      ),

    form_param_value: ($) =>
      prec.right(
        choice(
          $.variable,
          seq(
            token(PARAM_VALUE_CHARS),
            repeat(
              choice(
                $.variable,
                token(PARAM_VALUE_CHARS),
                token(prec(2, seq(SPACES_TABS, /[^\n\r&#]/))),
              ),
            ),
          ),
        ),
      ),

    raw_body: ($) =>
      prec(
        2,
        seq(
          choice(
            token(prec(2, seq(/[^=\n\r\-<{\[]+/, NL))),
            token(prec(2, seq(/-[^-=\n\r]+/, NL))),
          ),
          optional($._raw_body),
        ),
      ),
    _raw_body: ($) =>
      seq(token(prec(PREC.RAW_BODY, LINE_TAIL)), optional($._raw_body)),

    header_entity: (_) => /[\w\-]+/,
    identifier: (_) =>
      /[A-Za-z_.$\d\u00A1-\uFFFF-]+(\[[^\]]+\]|\.[A-Za-z_.$\d\u00A1-\uFFFF-]+|\([^)]*\))*/,
    path: ($) =>
      prec.right(repeat1(choice(WORD_CHAR, PUNCTUATION, $.variable, ESCAPED))),
    value: ($) => repeat1(choice(WORD_CHAR, PUNCTUATION, $.variable, WS)),
    _blank_line: (_) => seq(OPTIONAL_WS, token(prec(-1, NL))),
  },
});

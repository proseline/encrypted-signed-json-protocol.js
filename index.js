var AJV = require("ajv");
var Duplexify = require("duplexify");
var assert = require("assert");
var inherits = require("inherits");
var lengthPrefixedStream = require("length-prefixed-stream");
var sodium = require("sodium-universal");
var stringify = require("fast-json-stable-stringify");
var through2 = require("through2");

var STREAM_NONCEBYTES = sodium.crypto_stream_NONCEBYTES;
var STREAM_KEYBYTES = sodium.crypto_stream_KEYBYTES;

var SIGN_BYTES = sodium.crypto_sign_BYTES;
var SEEDBYTES = sodium.crypto_sign_SEEDBYTES;
var PUBLICKEYBYTES = sodium.crypto_sign_PUBLICKEYBYTES;
var SECRETKEYBYTES = sodium.crypto_sign_SECRETKEYBYTES;

var HANDSHAKE_PREFIX = 0;

module.exports = function(options) {
  assert.equal(typeof options, "object", "argument must be Object");

  var version = options.version;
  assert.equal(typeof version, "number", "version must be Number");
  assert(version > 0, "version must be greater than zero");
  assert(Number.isSafeInteger(version), "version must be safe integer");

  var messages = options.messages;
  assert.equal(typeof messages, "object", "messages must be Object");
  var messageNames = Object.keys(messages);
  assert(messageNames.length !== 0, "messages must have properties");

  var ajv = new AJV();
  var messageTypesByName = {};
  var messageTypesByPrefix = {};
  var messageTypePrefixes = [0];
  messageNames.sort().forEach(function(name, index) {
    var options = messages[name];
    assert(options.hasOwnProperty("schema"), "message type must have schema");
    if (options.hasOwnProperty("verify")) {
      assert.equal(
        typeof options.verify,
        "function",
        "verify must be Function"
      );
    }
    var schema = options.schema;
    var valid = ajv.compile(schema);
    var prefix = index + 1; // Reserve prefix 0 for handshakes.
    messageTypePrefixes.push(prefix);
    messageTypesByName[name] = messageTypesByPrefix[prefix] = {
      name: name,
      valid: valid,
      verify:
        options.verify ||
        function() {
          return true;
        },
      prefix: prefix
    };
    Protocol.prototype[name] = function(data, callback) {
      this._sendMessage(name, data, callback);
    };
  });

  var validTuple = ajv.compile({
    title: "Protocol Message",
    type: "array",
    items: [
      {
        title: "Message Type Prefix",
        type: "number",
        enum: messageTypePrefixes
      },
      {
        title: "Signature",
        type: "string",
        pattern: "^[a-f0-9]{128}$"
      },
      {
        title: "Message Payload"
        /* anything */
      }
    ],
    additionalItems: false
  });

  var validHandshake = ajv.compile({
    title: "Handshake Message",
    type: "object",
    properties: {
      version: {
        title: "Protocol Version",
        type: "number",
        multipleOf: 1,
        minimum: 1
      },
      nonce: {
        title: "Encryption Nonce",
        type: "string",
        pattern: "^[a-f0-9]{" + STREAM_NONCEBYTES * 2 + "}$"
      }
    },
    required: ["version", "nonce"],
    additionalProperties: false
  });

  function Protocol(options) {
    assert.equal(typeof options, "object", "argument must be object");

    if (!(this instanceof Protocol)) return new Protocol(options);

    var replicationKey = (this._replicationKey = options.replicationKey);
    assert(Buffer.isBuffer(replicationKey), "replicationKey must be Buffer");
    assert.equal(
      replicationKey.byteLength,
      STREAM_KEYBYTES,
      "replicationKey must be crypto_stream_KEYBYTES long"
    );

    if (
      options.hasOwnProperty("publicKey") &&
      options.hasOwnProperty("secretKey")
    ) {
      assert(Buffer.isBuffer(options.publicKey), "publicKey must be Buffer");
      assert.equal(
        options.publicKey.byteLength,
        PUBLICKEYBYTES,
        "seed must be crypto_sign_PUBLICKEYBYTES long"
      );
      assert(Buffer.isBuffer(options.secretKey), "secretKey must be Buffer");
      assert.equal(
        options.secretKey.byteLength,
        SECRETKEYBYTES,
        "seed must be crypto_sign_SECRETKEYBYTES long"
      );
      this._publicKey = options.publicKey;
      this._secretKey = options.secretKey;
    } else if (options.hasOwnProperty("seed")) {
      assert(Buffer.isBuffer(options.seed), "seed must be Buffer");
      assert.equal(
        options.seed.byteLength,
        SEEDBYTES,
        "seed must be crypto_sign_SEEDBYTES long"
      );
      var seed = options.seed;
      this._publicKey = Buffer.alloc(PUBLICKEYBYTES);
      this._secretKey = Buffer.alloc(SECRETKEYBYTES);
      sodium.crypto_sign_seed_keypair(this._publicKey, this._secretKey, seed);
    } else {
      assert.fail("must provide secretKey and publicKey or seed");
    }

    this._initializeReadable();
    this._initializeWritable();
    Duplexify.call(this, this._writableStream, this._readableStream);
  }

  Protocol.prototype._initializeReadable = function() {
    var self = this;

    // Cryptographic stream using our nonce and the secret key.
    self._sendingNonce = Buffer.alloc(STREAM_NONCEBYTES);
    sodium.randombytes_buf(self._sendingNonce);
    self._sendingCipher = initializeCipher(
      self._sendingNonce,
      self._replicationKey
    );

    self._encoderStream = lengthPrefixedStream.encode();

    self._readableStream = through2.obj(function(chunk, _, done) {
      assert(Buffer.isBuffer(chunk));
      // Once we've sent our nonce, encrypt.
      if (self._sentNonce) {
        self._sendingCipher.update(chunk, chunk);
      }
      this.push(chunk);
      done();
    });

    self._encoderStream
      .pipe(self._readableStream)
      .once("error", function(error) {
        self.destroy(error);
      });
  };

  Protocol.prototype._initializeWritable = function() {
    var self = this;

    // Cryptographic stream using our peer's nonce, which we've yet
    // to receive, and the secret key.
    self._receivingNonce = null;
    self._receivingCipher = null;

    self._writableStream = through2(function(chunk, encoding, done) {
      assert(Buffer.isBuffer(chunk));
      // Once we've been given a nonce, decrypt.
      if (self._receivingCipher) {
        self._receivingCipher.update(chunk, chunk);
      }
      // Until we've been given a nonce, write in the clear.
      done(null, chunk);
    });

    self._parserStream = through2.obj(function(chunk, _, done) {
      self._parse(chunk, function(error) {
        if (error) return done(error);
        done();
      });
    });

    self._writableStream
      .pipe(lengthPrefixedStream.decode())
      .pipe(self._parserStream)
      .once("error", function(error) {
        self.destroy(error);
      });
  };

  // Send our handshake message.
  Protocol.prototype.handshake = function(callback) {
    assert.equal(typeof callback, "function");
    var self = this;
    if (self._sentNonce) return callback(new Error("already sent handshake"));
    self._encode(
      HANDSHAKE_PREFIX,
      {
        version: version,
        nonce: self._sendingNonce.toString("hex")
      },
      function(error) {
        if (error) return callback(error);
        self._sentNonce = true;
        callback();
      }
    );
  };

  // Send a protocol-defined message.
  //
  // The constructor adds functions to the prototype for sending each
  // message type, which call this function in turn.
  Protocol.prototype._sendMessage = function(typeName, data, callback) {
    assert(
      messageTypesByName.hasOwnProperty(typeName),
      "unknown message type: " + typeName
    );
    assert.equal(typeof callback, "function", "callback must be function");
    var type = messageTypesByName[typeName];
    try {
      assert(type.valid(data));
      assert(type.verify(data));
    } catch (error) {
      var moreInformativeError = new Error("invalid " + typeName);
      moreInformativeError.errors = type.valid.errors;
      throw moreInformativeError;
    }
    this._encode(type.prefix, data, callback);
  };

  Protocol.prototype.finalize = function(callback) {
    assert(typeof callback === "function");
    var self = this;
    self._finalize(function(error) {
      if (error) return self.destroy(error);
      self._encoderStream.end(callback);
      self._sendingCipher.final();
      self._sendingCipher = null;
      self._receivingCipher.final();
      self._receivingCipher = null;
    });
  };

  Protocol.prototype._encode = function(prefix, data, callback) {
    var tuple = [prefix];
    var dataBuffer = Buffer.from(stringify(data), "utf8");
    var signature = Buffer.alloc(SIGN_BYTES);
    sodium.crypto_sign_detached(signature, dataBuffer, this._secretKey);
    tuple.push(signature.toString("hex"));
    tuple.push(data);
    this._encoderStream.write(
      Buffer.from(JSON.stringify(tuple), "utf8"),
      callback
    );
  };

  Protocol.prototype._validSignature = function(signature, data) {
    return sodium.crypto_sign_verify_detached(
      Buffer.from(signature, "hex"),
      Buffer.from(stringify(data)),
      Buffer.from(this._publicKey, "hex")
    );
  };

  Protocol.prototype._parse = function(message, callback) {
    try {
      var parsed = JSON.parse(message);
    } catch (error) {
      return callback(error);
    }
    if (!validTuple(parsed)) {
      return callback(new Error("invalid tuple"));
    }
    var prefix = parsed[0];
    var signature = parsed[1];
    var body = parsed[2];
    if (prefix === 0 && validHandshake(body)) {
      if (version !== body.version) {
        var error = new Error("version mismatch");
        error.version = body.version;
        return callback(error);
      }
      if (!this._receivingCipher) {
        this._receivingNonce = Buffer.from(body.nonce, "hex");
        assert.equal(this._receivingNonce.byteLength, STREAM_NONCEBYTES);
        this._receivingCipher = initializeCipher(
          this._receivingNonce,
          this._replicationKey
        );
        this.emit("handshake");
        return callback();
      }
      this.emit("handshake");
      return callback();
    }
    if (!this._validSignature(signature, body)) {
      return callback(new Error("invalid signature"));
    }
    var type = messageTypesByPrefix[prefix];
    if (!type || !type.valid(body) || !type.verify(body)) {
      this.emit("invalid", body);
      return callback();
    }
    this.emit(type.name, body);
    return callback();
  };

  inherits(Protocol, Duplexify);

  return Protocol;
};

function initializeCipher(nonce, secretKey) {
  assert(Buffer.isBuffer(nonce));
  assert.equal(nonce.byteLength, STREAM_NONCEBYTES);
  assert(Buffer.isBuffer(secretKey));
  assert.equal(secretKey.byteLength, STREAM_KEYBYTES);
  return sodium.crypto_stream_xor_instance(nonce, secretKey);
}

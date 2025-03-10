"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.getIndexMeta = getIndexMeta;
exports.getIndexStringLength = getIndexStringLength;
exports.getIndexableStringMonad = getIndexableStringMonad;
exports.getNumberIndexString = getNumberIndexString;
exports.getPrimaryKeyFromIndexableString = getPrimaryKeyFromIndexableString;
exports.getStartIndexStringFromLowerBound = getStartIndexStringFromLowerBound;
exports.getStartIndexStringFromUpperBound = getStartIndexStringFromUpperBound;
exports.getStringLengthOfIndexNumber = getStringLengthOfIndexNumber;
var _rxSchemaHelper = require("./rx-schema-helper.js");
var _index = require("./plugins/utils/index.js");
var _queryPlanner = require("./query-planner.js");
/**
 * For some RxStorage implementations,
 * we need to use our custom crafted indexes
 * so we can easily iterate over them. And sort plain arrays of document data.
 *
 * We really often have to craft an index string for a given document.
 * Performance of everything in this file is very important
 * which is why the code sometimes looks strange.
 * Run performance tests before and after you touch anything here!
 */

/**
 * Prepare all relevant information
 * outside of the returned function
 * from getIndexableStringMonad()
 * to save performance when the returned
 * function is called many times.
 */

function getIndexMeta(schema, index) {
  var fieldNameProperties = index.map(fieldName => {
    var schemaPart = (0, _rxSchemaHelper.getSchemaByObjectPath)(schema, fieldName);
    if (!schemaPart) {
      throw new Error('not in schema: ' + fieldName);
    }
    var type = schemaPart.type;
    var parsedLengths;
    if (type === 'number' || type === 'integer') {
      parsedLengths = getStringLengthOfIndexNumber(schemaPart);
    }
    var getValue = (0, _index.objectPathMonad)(fieldName);
    var maxLength = schemaPart.maxLength ? schemaPart.maxLength : 0;
    var getIndexStringPart;
    if (type === 'string') {
      getIndexStringPart = docData => {
        var fieldValue = getValue(docData);
        if (!fieldValue) {
          fieldValue = '';
        }
        return fieldValue.padEnd(maxLength, ' ');
      };
    } else if (type === 'boolean') {
      getIndexStringPart = docData => {
        var fieldValue = getValue(docData);
        return fieldValue ? '1' : '0';
      };
    } else {
      // number
      getIndexStringPart = docData => {
        var fieldValue = getValue(docData);
        return getNumberIndexString(parsedLengths, fieldValue);
      };
    }
    var ret = {
      fieldName,
      schemaPart,
      parsedLengths,
      getValue,
      getIndexStringPart
    };
    return ret;
  });
  return fieldNameProperties;
}

/**
 * Crafts an indexable string that can be used
 * to check if a document would be sorted below or above
 * another documents, dependent on the index values.
 * @monad for better performance
 *
 * IMPORTANT: Performance is really important here
 * which is why we code so 'strange'.
 * Always run performance tests when you want to
 * change something in this method.
 */
function getIndexableStringMonad(schema, index) {
  var fieldNameProperties = getIndexMeta(schema, index);
  var fieldNamePropertiesAmount = fieldNameProperties.length;
  var indexPartsFunctions = fieldNameProperties.map(r => r.getIndexStringPart);

  /**
   * @hotPath Performance of this function is very critical!
   */
  var ret = function (docData) {
    var str = '';
    for (var i = 0; i < fieldNamePropertiesAmount; ++i) {
      str += indexPartsFunctions[i](docData);
    }
    return str;
  };
  return ret;
}
function getStringLengthOfIndexNumber(schemaPart) {
  var minimum = Math.floor(schemaPart.minimum);
  var maximum = Math.ceil(schemaPart.maximum);
  var multipleOf = schemaPart.multipleOf;
  var valueSpan = maximum - minimum;
  var nonDecimals = valueSpan.toString().length;
  var multipleOfParts = multipleOf.toString().split('.');
  var decimals = 0;
  if (multipleOfParts.length > 1) {
    decimals = multipleOfParts[1].length;
  }
  return {
    minimum,
    maximum,
    nonDecimals,
    decimals,
    roundedMinimum: minimum
  };
}
function getIndexStringLength(schema, index) {
  var fieldNameProperties = getIndexMeta(schema, index);
  var length = 0;
  fieldNameProperties.forEach(props => {
    var schemaPart = props.schemaPart;
    var type = schemaPart.type;
    if (type === 'string') {
      length += schemaPart.maxLength;
    } else if (type === 'boolean') {
      length += 1;
    } else {
      var parsedLengths = props.parsedLengths;
      length = length + parsedLengths.nonDecimals + parsedLengths.decimals;
    }
  });
  return length;
}
function getPrimaryKeyFromIndexableString(indexableString, primaryKeyLength) {
  var paddedPrimaryKey = indexableString.slice(primaryKeyLength * -1);
  // we can safely trim here because the primary key is not allowed to start or end with a space char.
  var primaryKey = paddedPrimaryKey.trim();
  return primaryKey;
}
function getNumberIndexString(parsedLengths, fieldValue) {
  /**
   * Ensure that the given value is in the boundaries
   * of the schema, otherwise it would create a broken index string.
   * This can happen for example if you have a minimum of 0
   * and run a query like
   * selector {
   *  numField: { $gt: -1000 }
   * }
   */
  if (typeof fieldValue === 'undefined') {
    fieldValue = 0;
  }
  if (fieldValue < parsedLengths.minimum) {
    fieldValue = parsedLengths.minimum;
  }
  if (fieldValue > parsedLengths.maximum) {
    fieldValue = parsedLengths.maximum;
  }
  var nonDecimalsValueAsString = (Math.floor(fieldValue) - parsedLengths.roundedMinimum).toString();
  var str = nonDecimalsValueAsString.padStart(parsedLengths.nonDecimals, '0');
  if (parsedLengths.decimals > 0) {
    var splitByDecimalPoint = fieldValue.toString().split('.');
    var decimalValueAsString = splitByDecimalPoint.length > 1 ? splitByDecimalPoint[1] : '0';
    str += decimalValueAsString.padEnd(parsedLengths.decimals, '0');
  }
  return str;
}
function getStartIndexStringFromLowerBound(schema, index, lowerBound, inclusiveStart) {
  var str = '';
  index.forEach((fieldName, idx) => {
    var schemaPart = (0, _rxSchemaHelper.getSchemaByObjectPath)(schema, fieldName);
    var bound = lowerBound[idx];
    var type = schemaPart.type;
    switch (type) {
      case 'string':
        var maxLength = (0, _index.ensureNotFalsy)(schemaPart.maxLength);
        if (typeof bound === 'string') {
          str += bound.padEnd(maxLength, ' ');
        } else {
          // str += ''.padStart(maxLength, inclusiveStart ? ' ' : INDEX_MAX);
          str += ''.padEnd(maxLength, ' ');
        }
        break;
      case 'boolean':
        if (bound === null) {
          str += inclusiveStart ? '0' : _queryPlanner.INDEX_MAX;
        } else {
          var boolToStr = bound ? '1' : '0';
          str += boolToStr;
        }
        break;
      case 'number':
      case 'integer':
        var parsedLengths = getStringLengthOfIndexNumber(schemaPart);
        if (bound === null || bound === _queryPlanner.INDEX_MIN) {
          var fillChar = inclusiveStart ? '0' : _queryPlanner.INDEX_MAX;
          str += fillChar.repeat(parsedLengths.nonDecimals + parsedLengths.decimals);
        } else {
          str += getNumberIndexString(parsedLengths, bound);
        }
        break;
      default:
        throw new Error('unknown index type ' + type);
    }
  });
  return str;
}
function getStartIndexStringFromUpperBound(schema, index, upperBound, inclusiveEnd) {
  var str = '';
  index.forEach((fieldName, idx) => {
    var schemaPart = (0, _rxSchemaHelper.getSchemaByObjectPath)(schema, fieldName);
    var bound = upperBound[idx];
    var type = schemaPart.type;
    switch (type) {
      case 'string':
        var maxLength = (0, _index.ensureNotFalsy)(schemaPart.maxLength);
        if (typeof bound === 'string' && bound !== _queryPlanner.INDEX_MAX) {
          str += bound.padEnd(maxLength, ' ');
        } else {
          str += ''.padEnd(maxLength, inclusiveEnd ? _queryPlanner.INDEX_MAX : ' ');
        }
        break;
      case 'boolean':
        if (bound === null) {
          str += inclusiveEnd ? '0' : '1';
        } else {
          var boolToStr = bound ? '1' : '0';
          str += boolToStr;
        }
        break;
      case 'number':
      case 'integer':
        var parsedLengths = getStringLengthOfIndexNumber(schemaPart);
        if (bound === null || bound === _queryPlanner.INDEX_MAX) {
          var fillChar = inclusiveEnd ? '9' : '0';
          str += fillChar.repeat(parsedLengths.nonDecimals + parsedLengths.decimals);
        } else {
          str += getNumberIndexString(parsedLengths, bound);
        }
        break;
      default:
        throw new Error('unknown index type ' + type);
    }
  });
  return str;
}
//# sourceMappingURL=custom-index.js.map
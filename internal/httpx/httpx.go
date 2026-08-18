// Package httpx holds the small request/response helpers shared by every handler.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
)

// Error is an API error carrying an HTTP status and a stable machine code.
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func Errorf(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// Common errors.
var (
	ErrUnauthorized = &Error{Status: http.StatusUnauthorized, Code: "unauthorized", Message: "Sign in to continue."}
	ErrForbidden    = &Error{Status: http.StatusForbidden, Code: "forbidden", Message: "You do not have access to that."}
	ErrNotFound     = &Error{Status: http.StatusNotFound, Code: "not_found", Message: "Not found."}
)

func BadRequest(msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "bad_request", Message: msg}
}

func Conflict(msg string) *Error {
	return &Error{Status: http.StatusConflict, Code: "conflict", Message: msg}
}

// JSON writes v as a JSON body with the given status.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("httpx: encode response: %v", err)
	}
}

// NoContent ends the request with 204.
func NoContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

// Fail writes err as JSON, mapping unknown errors to 500 without leaking internals.
func Fail(w http.ResponseWriter, r *http.Request, err error) {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		JSON(w, apiErr.Status, apiErr)
		return
	}
	log.Printf("httpx: %s %s: %v", r.Method, r.URL.Path, err)
	JSON(w, http.StatusInternalServerError, &Error{
		Code:    "internal",
		Message: "Something went wrong.",
	})
}

// DecodeJSON reads a JSON body into v, rejecting unknown fields and oversized bodies.
func DecodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return BadRequest("Invalid request body.")
	}
	return nil
}

// PathInt reads a {name} path value as an int64.
func PathInt(r *http.Request, name string) (int64, error) {
	raw := r.PathValue(name)
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, BadRequest("Invalid " + name + ".")
	}
	return n, nil
}

// QueryInt reads a query parameter as an int, falling back to def.
func QueryInt(r *http.Request, name string, def int) int {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}

// Clamp bounds n to [lo, hi].
func Clamp(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

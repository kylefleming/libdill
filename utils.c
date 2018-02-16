/*

  Copyright (c) 2017 Martin Sustrik

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"),
  to deal in the Software without restriction, including without limitation
  the rights to use, copy, modify, merge, publish, distribute, sublicense,
  and/or sell copies of the Software, and to permit persons to whom
  the Software is furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included
  in all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
  THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
  FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
  IN THE SOFTWARE.

*/

#include <string.h>
#include <sys/param.h>
#include <sys/resource.h>

#include "utils.h"

int dill_maxfds(void) {
    /* Get the maximum number of file descriptors. */
    struct rlimit rlim;
    int rc = getrlimit(RLIMIT_NOFILE, &rlim);
    dill_assert(rc == 0);
    int maxfds = rlim.rlim_max;
#if defined BSD
    /* On newer versions of OSX, the above behaves weirdly and returns -1, 
       so use OPEN_MAX instead. */
    if(maxfds < 0) return OPEN_MAX;
#endif
    return maxfds;
}

uint16_t dill_gets(const uint8_t *buf) {
    return (((uint16_t)buf[0]) << 8) |
           ((uint16_t)buf[1]);
}

void dill_puts(uint8_t *buf, uint16_t val) {
    buf[0] = (uint8_t)(((val) >> 8) & 0xff);
    buf[1] = (uint8_t)(val & 0xff);
}

uint32_t dill_getl(const uint8_t *buf) {
    return (((uint32_t)buf[0]) << 24) |
           (((uint32_t)buf[1]) << 16) |
           (((uint32_t)buf[2]) << 8) |
           ((uint32_t)buf[3]);
}

void dill_putl(uint8_t *buf, uint32_t val) {
    buf[0] = (uint8_t)(((val) >> 24) & 0xff);
    buf[1] = (uint8_t)(((val) >> 16) & 0xff);
    buf[2] = (uint8_t)(((val) >> 8) & 0xff);
    buf[3] = (uint8_t)(val & 0xff);
}

uint64_t dill_getll(const uint8_t *buf) {
    return (((uint64_t)buf[0]) << 56) |
           (((uint64_t)buf[1]) << 48) |
           (((uint64_t)buf[2]) << 40) |
           (((uint64_t)buf[3]) << 32) |
           (((uint64_t)buf[4]) << 24) |
           (((uint64_t)buf[5]) << 16) |
           (((uint64_t)buf[6]) << 8) |
           (((uint64_t)buf[7] << 0));
}

void dill_putll(uint8_t *buf, uint64_t val) {
    buf[0] = (uint8_t)((val >> 56) & 0xff);
    buf[1] = (uint8_t)((val >> 48) & 0xff);
    buf[2] = (uint8_t)((val >> 40) & 0xff);
    buf[3] = (uint8_t)((val >> 32) & 0xff);
    buf[4] = (uint8_t)((val >> 24) & 0xff);
    buf[5] = (uint8_t)((val >> 16) & 0xff);
    buf[6] = (uint8_t)((val >> 8) & 0xff);
    buf[7] = (uint8_t)(val & 0xff);
}

const char *dill_lstrip(const char *string, char delim) {
    const char *pos = string;
    while(*pos && *pos == delim) ++pos;
    return pos;
}

const char *dill_rstrip(const char *string, char delim) {
    const char *end = string + strlen(string) - 1;
    while(end > string && *end == delim) --end;
    return ++end;
}

